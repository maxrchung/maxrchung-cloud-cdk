import * as cdk from '@aws-cdk/core';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as backup from '@aws-cdk/aws-backup';
// import * as sqs from '@aws-cdk/aws-sqs';

// https://bobbyhadz.com/blog/aws-cdk-ec2-instance-example
// https://www.pedroalonso.net/blog/hosting-postgresql-on-a-t4g-graviton2-arm-instance-on-aws-ec2
// /var/lib/pgsql/data
// https://blog.logrocket.com/setting-up-a-remote-postgres-database-server-on-ubuntu-18-04

export class MaxrchungCloudCdkStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'cloud-vpc', {
      natGateways: 0,
    });

    const securityGroup = new ec2.SecurityGroup(this, 'database-security-group', {
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

    const backupPlan = backup.BackupPlan.daily35DayRetention(this, 'database-backup-plan');
    backupPlan.addSelection('database-backup-selection', {
      resources: [
        backup.BackupResource.fromEc2Instance(ec2Instance),
      ],
    });

    // The code that defines your stack goes here

    // example resource
    // const queue = new sqs.Queue(this, 'MaxrchungCloudCdkQueue', {
    //   visibilityTimeout: cdk.Duration.seconds(300)
    // });
  }
}
