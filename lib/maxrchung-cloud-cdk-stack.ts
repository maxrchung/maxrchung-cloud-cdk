import * as cdk from '@aws-cdk/core';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as s3 from '@aws-cdk/aws-s3';
import * as route53 from '@aws-cdk/aws-route53';
import * as certificatemanager from '@aws-cdk/aws-certificatemanager';
import * as elbv2 from '@aws-cdk/aws-elasticloadbalancingv2';
import * as ecs from '@aws-cdk/aws-ecs';
import * as targets from '@aws-cdk/aws-route53-targets';
import { Tag, Tags } from '@aws-cdk/core';

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
      instanceId: ec2Instance.instanceId,
    });

    new s3.Bucket(this, 'database-backup', {
      bucketName: 'maxrchung-database-backup', // Has to be globally unique
      lifecycleRules: [{
        expiration: cdk.Duration.days(35),
      }],
    });

    const balancer = new elbv2.ApplicationLoadBalancer(this, `cloud-application-load-balancer`, {
      loadBalancerName: 'cloud-application-load-balancer',
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC
      },
      internetFacing: true,
    });

    const hostedZone = new route53.PublicHostedZone(this, 'maxrchung-hosted-zone', {
      zoneName: 'maxrchung.com',
    });

    new route53.ARecord(this, 'maxrchung-a-record', {
      recordName: 'maxrchung.com',
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(balancer)),
    });

    new route53.CnameRecord(this, 'maxrchung-cname-record', {
      recordName: '*.maxrchung.com', // Forwards all subdomains
      zone: hostedZone,
      domainName: 'maxrchung.com',
    });

    const certificate = new certificatemanager.Certificate(this, 'maxrchung-certificate', {
      domainName: 'maxrchung.com',
      validation: certificatemanager.CertificateValidation.fromDns(hostedZone),
      subjectAlternativeNames: [
        'maxrchung.com',
        '*.maxrchung.com',
      ]
    });

   balancer.addListener('cloud-balancer-listener-https', {
      open: true,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [
        certificate,
      ],
      defaultAction: elbv2.ListenerAction.fixedResponse(404),
    });

    Tags.of(balancer).add('balancer-identifier', 'cloud-balancer');

    balancer.addListener('cloud-balancer-listener-http', {
      open: true,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: elbv2.ApplicationProtocol.HTTPS,
        port: '443',
      }),
    });

    new ecs.Cluster(this, 'cloud-cluster', {
      clusterName: 'cloud-cluster',
      vpc,
    });
  }
}
