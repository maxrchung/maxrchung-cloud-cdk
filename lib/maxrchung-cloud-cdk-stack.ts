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

export class MaxrchungCloudCdkStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    const vpc = new ec2.Vpc(this, 'cloud-vpc', {
      vpcName: 'cloud-vpc',
      natGateways: 0
    })

    const databaseSecurityGroup = new ec2.SecurityGroup(this, 'database-security-group', {
      securityGroupName: 'database-security-group',
      vpc,
      allowAllOutbound: true
    })

    databaseSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'ssh')
    databaseSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(5432), 'postgres')
    databaseSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(27017), 'mongo')

    const ec2Instance = new ec2.Instance(this, 'database-ec2', {
      instanceName: 'database-ec2',
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC
      },
      securityGroup: databaseSecurityGroup,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.NANO),
      machineImage: ec2.MachineImage.latestAmazonLinux({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
        cpuType: ec2.AmazonLinuxCpuType.ARM_64
      }),
      keyName: 'cloud-key' // Key was manually created through console,
    })

    // Run an EC2 backup once a week and retain for a month
    const plan = new backup.BackupPlan(this, 'database-backup-plan', {
      backupPlanName: 'database-backup-plan',
      backupPlanRules: [
        new backup.BackupPlanRule({
          ruleName: 'database-backup-plan-rule',
          deleteAfter: cdk.Duration.days(35),
          scheduleExpression: events.Schedule.cron({ weekDay: 'THU', hour: '5', minute: '0' })
        })
      ],
      backupVault: new backup.BackupVault(this, 'database-backup-vault', {
        backupVaultName: 'database-backup-vault'
      })
    })
    plan.addSelection('database-plan-selection', {
      backupSelectionName: 'database-plan-selection',
      resources: [backup.BackupResource.fromEc2Instance(ec2Instance)]
    })

    new ec2.CfnEIP(this, 'database-elastic-ip', {
      instanceId: ec2Instance.instanceId
    })

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

    const balancer = new elbv2.ApplicationLoadBalancer(this, `cloud-application-load-balancer`, {
      loadBalancerName: 'cloud-application-load-balancer',
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC
      },
      internetFacing: true,
      idleTimeout: cdk.Duration.hours(1) // For longer running connections, e.g. THRUSTIN websockets
    })

    new route53.ARecord(this, 'maxrchung-a-record', {
      recordName: 'maxrchung.com',
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(balancer))
    })

    new route53.CnameRecord(this, 'maxrchung-cname-record', {
      recordName: '*.maxrchung.com',
      zone: hostedZone,
      domainName: 'maxrchung.com'
    })

    new route53.CnameRecord(this, 'maxrchung-cname-server-record', {
      recordName: '*.server.maxrchung.com',
      zone: hostedZone,
      domainName: 'maxrchung.com'
    })

    new route53.CnameRecord(this, 'maxrchung-cname-api-record', {
      recordName: '*.api.maxrchung.com',
      zone: hostedZone,
      domainName: 'maxrchung.com'
    })

    const certificate = new certificatemanager.Certificate(this, 'maxrchung-certificate', {
      domainName: 'maxrchung.com',
      validation: certificatemanager.CertificateValidation.fromDns(hostedZone),
      subjectAlternativeNames: ['maxrchung.com', '*.maxrchung.com', '*.server.maxrchung.com', '*.api.maxrchung.com']
    })

    const listener = balancer.addListener('cloud-balancer-listener-https', {
      open: true,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [certificate],
      defaultAction: elbv2.ListenerAction.fixedResponse(404)
    })

    balancer.addListener('cloud-balancer-listener-http', {
      open: true,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: elbv2.ApplicationProtocol.HTTPS,
        port: '443'
      })
    })

    const cluster = new ecs.Cluster(this, 'cloud-cluster', {
      clusterName: 'cloud-cluster',
      vpc
    })

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'cloud-task-definition', {
      family: 'cloud-task-family'
    })

    const fargate = new ecs.FargateService(this, 'cloud-fargate', {
      serviceName: 'cloud-fargate',
      cluster,
      desiredCount: 1,
      taskDefinition,
      assignPublicIp: true
    })

    taskDefinition.addContainer('maxrchung-rails-container', {
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
      portMappings: [{ containerPort: 3000 }]
    })

    taskDefinition.addContainer('thrustin-container', {
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
      portMappings: [{ containerPort: 3012 }]
    })

    taskDefinition.addContainer('functional-vote-container', {
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
      portMappings: [{ containerPort: 4000 }]
    })

    fargate.registerLoadBalancerTargets(
      {
        containerName: 'maxrchung-rails-container',
        newTargetGroupId: 'maxrchung-rails-target-group',
        listener: ecs.ListenerConfig.applicationListener(listener, {
          priority: 100,
          conditions: [elbv2.ListenerCondition.hostHeaders(['maxrchung.com', 'www.maxrchung.com'])]
        })
      },
      {
        containerName: 'thrustin-container',
        newTargetGroupId: 'thrustin-target-group',
        listener: ecs.ListenerConfig.applicationListener(listener, {
          healthCheck: {
            // There is no health check endpoint on the backend. When you try and hit the root,
            // the backend is returning a 400 as it expects a websocket connection.
            healthyHttpCodes: '200,400',
            // Make logging less filled with web socket connection errors, max value is 300
            interval: cdk.Duration.seconds(300)
          },
          priority: 200,
          conditions: [elbv2.ListenerCondition.hostHeaders(['thrustin.server.maxrchung.com'])]
        })
      },
      {
        containerName: 'functional-vote-container',
        newTargetGroupId: 'functional-vote-target-group',
        listener: ecs.ListenerConfig.applicationListener(listener, {
          priority: 300,
          conditions: [elbv2.ListenerCondition.hostHeaders(['functionalvote.api.maxrchung.com'])]
        })
      }
    )
  }
}
