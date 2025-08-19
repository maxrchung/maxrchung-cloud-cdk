import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import * as backup from 'aws-cdk-lib/aws-backup'
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery'
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch'
import * as sns from 'aws-cdk-lib/aws-sns'
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions'
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions'
import { Construct } from 'constructs'

export class MaxrchungCloudCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    const hostedZone = new route53.PublicHostedZone(this, 'maxrchung-hosted-zone', {
      zoneName: 'maxrchung.com'
    })
    hostedZone.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN)
  }
}
