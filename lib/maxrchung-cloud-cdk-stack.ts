import * as cdk from '@aws-cdk/core';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as s3 from '@aws-cdk/aws-s3';
import * as route53 from '@aws-cdk/aws-route53';
import * as certificatemanager from '@aws-cdk/aws-certificatemanager';
import * as elbv2 from '@aws-cdk/aws-elasticloadbalancingv2';
import * as ecs from '@aws-cdk/aws-ecs';
import * as ssm from '@aws-cdk/aws-ssm';

const getParameter = (scope: cdk.Construct, parameterName: string) => 
  ssm.StringParameter.fromSecureStringParameterAttributes(scope, parameterName, {
    parameterName,
    version: 1,
  }).stringValue

export class MaxrchungCloudCdkStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'cloud-vpc', {
      vpcName: 'cloud-vpc',
      natGateways: 0,
    });

    const databaseSecurityGroup = new ec2.SecurityGroup(this, 'database-security-group', {
      securityGroupName: 'database-security-group',
      vpc,
      allowAllOutbound: true,
    });

    databaseSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(22),
      'ssh',
    );

    databaseSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(5432),
      'postgres',
    );

    databaseSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(27017),
      'mongo',
    );

    const ec2Instance = new ec2.Instance(this, 'database-ec2', {
      instanceName: 'database-ec2',
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
      securityGroup: databaseSecurityGroup,
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T4G,
        ec2.InstanceSize.NANO,
      ),
      machineImage: ec2.MachineImage.latestAmazonLinux({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      keyName: 'cloud-key', // Key was manually created through console
    });

    new ec2.CfnEIP(this, 'database-elastic-ip', {
      instanceId: ec2Instance.instanceId
    });

    new s3.Bucket(this, 'database-backup', {
      bucketName: 'maxrchung-database-backup', // Has to be globally unique
      lifecycleRules: [{
        expiration: cdk.Duration.days(35)
      }]
    });

    const hostedZone = new route53.PublicHostedZone(this, 'maxrchung-hosted-zone', {
      zoneName: 'maxrchung.com',
    });

    const certificate = new certificatemanager.Certificate(this, 'maxrchung-certificate', {
      domainName: 'maxrchung.com',
      validation: certificatemanager.CertificateValidation.fromDns(hostedZone),
    });

    const balancer = new elbv2.ApplicationLoadBalancer(this, `cloud-application-load-balancer`, {
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC
      },
      internetFacing: true,
    });

    const balancerSecurityGroup = new ec2.SecurityGroup(this, 'cloud-balancer-security-group', {
      vpc,
      allowAllOutbound: true,
    });

    balancerSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'https',
    );

    balancer.addSecurityGroup(balancerSecurityGroup);

    const listener = balancer.addListener('cloud-balancer-listener', {
      open: true,
      port: 443,
      certificates: [
        certificate
      ],
    });

    const cluster = new ecs.Cluster(this, 'cloud-cluster', {
      clusterName: 'cloud-cluster',
      vpc,
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'maxrchung-target-group', {
      port: 3000,
      vpc,
      protocol: elbv2.ApplicationProtocol.HTTP,
    });

    listener.addAction('maxrchung-rails-action', {
      priority: 5,
      conditions: [
        elbv2.ListenerCondition.hostHeaders([
          'maxrchung.com'
        ]),
      ],
      action: elbv2.ListenerAction.forward([
        targetGroup,
      ]),
    });

    const taskDefinition = new ecs.TaskDefinition(this, 'maxrchung-rails-task', {
      family: 'maxrchung-rails-task',
      compatibility: ecs.Compatibility.FARGATE,
      cpu: '256',
      memoryMiB: '512',
    });

    const container = taskDefinition.addContainer('maxrchung-rails-container', {
      containerName: 'maxrchung-rails-container',
      image: ecs.ContainerImage.fromRegistry('maxrchung/maxrchung-rails'),
      environment: {
        AWS_ACCESS_KEY_ID: getParameter(this, 'maxrchung-aws-access-key-id'),
        AWS_DEFAULT_REGION: getParameter(this, 'maxrchung-aws-default-region'),
        AWS_SECRET_ACCESS_KEY: getParameter(this, 'maxrchung-aws-secret-access-key'),
        DATABASE_HOST: getParameter(this, 'cloud-database-host'),
        DATABASE_PASSWORD: getParameter(this, 'cloud-database-password'),
        SECRET_KEY_BASE: getParameter(this, 'maxrchung-rails-secret-key-base'),
      },
    });

    container.addPortMappings({ containerPort: 3000 });

    // const fargateSecurityGroup = new ec2.SecurityGroup(this, 'maxrchung-rails-fargate-security-group', {
    //   securityGroupName: 'maxrchung-rails-fargate-security-group',
    //   vpc,
    //   allowAllOutbound: true,
    // });
    
    // fargateSecurityGroup.connections.allowFrom(
    //   balancerSecurityGroup,
    //   ec2.Port.allTcp(),
    //   'application load balancer'
    // );
    
    const fargate = new ecs.FargateService(this, 'maxrchung-rails-fargate', {
      serviceName: 'maxrchung-rails-service',
      cluster,
      desiredCount: 1,
      taskDefinition,
      // securityGroups: [
      //   fargateSecurityGroup
      // ],
      assignPublicIp: true,
    });

    fargate.attachToApplicationTargetGroup(targetGroup);
  }
}
