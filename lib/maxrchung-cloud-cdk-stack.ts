import * as cdk from '@aws-cdk/core';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as s3 from '@aws-cdk/aws-s3';

export class MaxrchungCloudCdkStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'cloud-vpc', {
      vpcName: 'cloud-vpc',
      natGateways: 0,
    });

    const securityGroup = new ec2.SecurityGroup(this, 'database-security-group', {
      securityGroupName: 'database-security-group',
      vpc,
      allowAllOutbound: true,
    });

    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(22),
      'ssh',
    );

    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(5432),
      'postgres',
    );

    securityGroup.addIngressRule(
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
      securityGroup,
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
  }
}
