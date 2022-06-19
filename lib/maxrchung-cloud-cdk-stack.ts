import * as cdk from '@aws-cdk/core'
import * as ec2 from '@aws-cdk/aws-ec2'
import * as s3 from '@aws-cdk/aws-s3'
import * as route53 from '@aws-cdk/aws-route53'
import * as certificatemanager from '@aws-cdk/aws-certificatemanager'
import * as elbv2 from '@aws-cdk/aws-elasticloadbalancingv2'
import * as ecs from '@aws-cdk/aws-ecs'
import * as targets from '@aws-cdk/aws-route53-targets'
import * as logs from '@aws-cdk/aws-logs'
import * as ssm from '@aws-cdk/aws-ssm'
import * as backup from '@aws-cdk/aws-backup'
import * as events from '@aws-cdk/aws-events'
import * as servicediscovery from '@aws-cdk/aws-servicediscovery'

export class MaxrchungCloudCdkStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    const vpc = new ec2.Vpc(this, 'cloud-vpc', {
      vpcName: 'cloud-vpc',
      natGateways: 0
    })

    // Manually maintaining EC2 that contains Postgres/Mongo databases and NGINX proxy
    // Decided to run these manually since it's much cheaper to run compared to AWS equivalent services (RDS/DocumentDB, ALB)
    // I had issues trying to specify EC2 through CDK since this is stateful, ran into problems where EC2 would be recreated because
    // I didn't specify a specific AMI

    const databaseSecurityGroup = new ec2.SecurityGroup(this, 'database-security-group', {
      securityGroupName: 'database-security-group',
      vpc,
      allowAllOutbound: true
    })

    databaseSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'ssh')
    databaseSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'http')
    databaseSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'https')
    databaseSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(5432), 'postgres')
    databaseSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(27017), 'mongo')

    // Manually set EC2 to use this backup plan as a safety insurance so that I don't have to go through setting up the server again
    backup.BackupPlan.daily35DayRetention(
      this,
      'database-backup-plan',
      new backup.BackupVault(this, 'database-backup-vault', {
        backupVaultName: 'database-backup-vault'
      })
    )

    // Manually associated this with EC2
    const databaseEip = new ec2.CfnEIP(this, 'database-elastic-ip')

    // More backup guarantees of individual databases
    // On the EC2, there are daily cron scripts to backup database dumps to this S3 location
    new s3.Bucket(this, 'database-backup', {
      bucketName: 'maxrchung-database-backup', // Has to be globally unique
      lifecycleRules: [
        {
          id: 'database-lifecycle-rule',
          expiration: cdk.Duration.days(35)
        }
      ]
    })

    const hostedZone = new route53.PublicHostedZone(this, 'maxrchung-hosted-zone', {
      zoneName: 'maxrchung.com'
    })

    new route53.ARecord(this, 'maxrchung-a-record', {
      recordName: 'maxrchung.com',
      zone: hostedZone,
      target: route53.RecordTarget.fromIpAddresses(databaseEip.ref)
    })

    new route53.CnameRecord(this, 'maxrchung-cname-record', {
      recordName: '*.maxrchung.com',
      zone: hostedZone,
      domainName: 'maxrchung.com'
    })

    const containersCluster = new ecs.Cluster(this, 'containers-cluster', {
      clusterName: 'containers-cluster',
      vpc
    })

    const containersTaskDefinition = new ecs.FargateTaskDefinition(this, 'containers-task-definition', {
      family: 'containers-family'
    })

    containersTaskDefinition.addContainer('maxrchung-rails-container', {
      containerName: 'maxrchung-rails-container',
      image: ecs.ContainerImage.fromRegistry('maxrchung/maxrchung-rails'),
      environment: {
        AWS_ACCESS_KEY_ID: ssm.StringParameter.valueForStringParameter(this, 'maxrchung-aws-access-key-id'),
        AWS_DEFAULT_REGION: ssm.StringParameter.valueForStringParameter(this, 'maxrchung-aws-default-region'),
        AWS_SECRET_ACCESS_KEY: ssm.StringParameter.valueForStringParameter(this, 'maxrchung-aws-secret-access-key'),
        DATABASE_HOST: ssm.StringParameter.valueForStringParameter(this, 'maxrchung-rails-database-host'),
        DATABASE_PASSWORD: ssm.StringParameter.valueForStringParameter(this, 'maxrchung-rails-database-password'),
        SECRET_KEY_BASE: ssm.StringParameter.valueForStringParameter(this, 'maxrchung-rails-secret-key-base')
      },
      logging: ecs.LogDriver.awsLogs({
        logGroup: new logs.LogGroup(this, 'maxrchung-rails-log-group', {
          logGroupName: 'maxrchung-rails-log-group',
          retention: logs.RetentionDays.ONE_MONTH
        }),
        streamPrefix: 'maxrchung-rails-log'
      }),
      portMappings: [{ containerPort: 3000 }],
      healthCheck: {
        command: ['CMD-SHELL', 'wget --no-verbose --tries=1 --spider http://localhost:3000 || exit 1']
      }
    })

    containersTaskDefinition.addContainer('thrustin-container', {
      containerName: 'thrustin-container',
      image: ecs.ContainerImage.fromRegistry('maxrchung/thrustin'),
      environment: {
        DATABASE_CONNECTION_STRING: ssm.StringParameter.valueForStringParameter(this, 'thrustin-database-url')
      },
      logging: ecs.LogDriver.awsLogs({
        logGroup: new logs.LogGroup(this, 'thrustin-log-group', {
          logGroupName: 'thrustin-log-group',
          retention: logs.RetentionDays.ONE_MONTH
        }),
        streamPrefix: 'thrustin-log'
      }),
      portMappings: [{ containerPort: 3012 }],
      healthCheck: {
        // WebSocket health check: https://stackoverflow.com/a/47357225
        // Gist for curl flags: https://gist.github.com/eneko/dc2d8edd9a4b25c5b0725dd123f98b10
        // cURL doesn't seem to automatically disconnect with "Connection: close", so I'm doing an -eq check for 28 (Operation timed out)
        // Bash bracket reference: https://dev.to/rpalo/bash-brackets-quick-reference-4eh6
        command: ['CMD-SHELL', 'curl -iN -m 3 -H "Connection: close" --header "Upgrade: websocket" -H "Sec-WebSocket-Key: SGVsbG8sIHdvcmxkIQ==" -H "Sec-WebSocket-Version: 13" http://localhost:3012; [ $? -eq 28 ] || exit 1']
      }
    })

    containersTaskDefinition.addContainer('functional-vote-container', {
      containerName: 'functional-vote-container',
      image: ecs.ContainerImage.fromRegistry('maxrchung/functional-vote'),
      environment: {
        DATABASE_URL: ssm.StringParameter.valueForStringParameter(this, 'functional-vote-database-url'),
        SECRET_KEY_BASE: ssm.StringParameter.valueForStringParameter(this, 'functional-vote-secret-key-base'),
        RECAPTCHA_PUBLIC_KEY: ssm.StringParameter.valueForStringParameter(this, 'functional-vote-recaptcha-public-key'),
        RECAPTCHA_PRIVATE_KEY: ssm.StringParameter.valueForStringParameter(this, 'functional-vote-recaptcha-private-key')
      },
      logging: ecs.LogDriver.awsLogs({
        logGroup: new logs.LogGroup(this, 'functional-vote-log-group', {
          logGroupName: 'functional-vote-log-group',
          retention: logs.RetentionDays.ONE_MONTH
        }),
        streamPrefix: 'functional-vote-log'
      }),
      portMappings: [{ containerPort: 4000 }],
      healthCheck: {
        command: ['CMD-SHELL', 'wget --no-verbose --tries=1 --spider http://localhost:4000 || exit 1']
      }
    })

    containersTaskDefinition.addContainer('retro-frontend-container', {
      containerName: 'retro-frontend-container',
      image: ecs.ContainerImage.fromRegistry('maxrchung/retro-frontend'),
      logging: ecs.LogDriver.awsLogs({
        logGroup: new logs.LogGroup(this, 'retro-frontend-log-group', {
          logGroupName: 'retro-frontend-log-group',
          retention: logs.RetentionDays.ONE_MONTH
        }),
        streamPrefix: 'retro-frontend-log'
      }),
      portMappings: [{ containerPort: 5001 }],
      healthCheck: {
        command: ['CMD-SHELL', 'wget --no-verbose --tries=1 --spider http://localhost:5001 || exit 1']
      }
    })

    containersTaskDefinition.addContainer('retro-backend-container', {
      containerName: 'retro-backend-container',
      image: ecs.ContainerImage.fromRegistry('maxrchung/retro-backend'),
      environment: {
        AWS_ACCESS_KEY_ID: ssm.StringParameter.valueForStringParameter(this, 'maxrchung-aws-access-key-id'),
        AWS_SECRET_ACCESS_KEY: ssm.StringParameter.valueForStringParameter(this, 'maxrchung-aws-secret-access-key')
      },
      logging: ecs.LogDriver.awsLogs({
        logGroup: new logs.LogGroup(this, 'retro-backend-log-group', {
          logGroupName: 'retro-backend-log-group',
          retention: logs.RetentionDays.ONE_MONTH
        }),
        streamPrefix: 'retro-backend-log'
      }),
      portMappings: [{ containerPort: 5000 }],
      healthCheck: {
        // wget health check: https://stackoverflow.com/a/47722899
        // Apollo Server health check endpoint: https://www.apollographql.com/docs/apollo-server/monitoring/health-checks/#http-level-health-checks
        command: ['CMD-SHELL', 'wget --no-verbose --tries=1 --spider http://localhost/.well-known/apollo/server-health || exit 1']
      }
    })

    const containersSecurityGroup = new ec2.SecurityGroup(this, 'containers-security-group', {
      securityGroupName: 'containers-security-group',
      vpc,
      allowAllOutbound: true
    })
    // EIP public IP
    containersSecurityGroup.addIngressRule(ec2.Peer.ipv4(databaseEip.ref + '/32'), ec2.Port.allTcp(), 'retro')
    // Private IPs
    containersSecurityGroup.addIngressRule(ec2.Peer.ipv4('10.0.0.0/16'), ec2.Port.allTcp(), 'retro')

    // Can't use EC2Service due to public access restrictions: https://stackoverflow.com/a/60885984
    const containersService = new ecs.FargateService(this, 'containers-fargate', {
      serviceName: 'containers-fargate',
      cluster: containersCluster,
      desiredCount: 1,
      taskDefinition: containersTaskDefinition,
      assignPublicIp: true,
      cloudMapOptions: {
        name: 'containers-cloud-options',
        cloudMapNamespace: new servicediscovery.PrivateDnsNamespace(this, 'containers-namespace', {
          name: 'containers.internal',
          vpc
        })
      },
      securityGroups: [containersSecurityGroup]
    })
  }
}
