import * as path from 'path';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as elasticbeanstalk from 'aws-cdk-lib/aws-elasticbeanstalk';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as deploy from 'aws-cdk-lib/aws-s3-deployment';
import { App, Fn, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as integ from '@aws-cdk/integ-tests-alpha';
import * as cpactions from 'aws-cdk-lib/aws-codepipeline-actions';

/**
 * To validate that the deployment actually succeeds, perform the following actions:
 *
 * 1. Delete the snapshot
 * 2. Run `yarn integ --update-on-failed --no-clean`
 * 3. Navigate to CodePipeline in the console and click 'Release change'
 *      - Before releasing the change, the pipeline will show a failure because it
 *        attempts to run on creation but the elastic beanstalk environment is not yet ready
 * 4. Navigate to Elastic Beanstalk and click on the URL for the application just deployed
 *      - You should see 'Congratulations' message
 * 5. Manually delete the 'aws-cdk-codepipeline-elastic-beanstalk-deploy' stack
 */

const app = new App({
  postCliContext: {
    '@aws-cdk/aws-lambda:useCdkManagedLogGroup': false,
    '@aws-cdk/aws-codepipeline:defaultPipelineTypeToV2': false,
    '@aws-cdk/pipelines:reduceStageRoleTrustScope': false,
  },
});

const stack = new Stack(app, 'aws-cdk-codepipeline-elastic-beanstalk-deploy');

const bucket = new s3.Bucket(stack, 'PipelineBucket', {
  versioned: true,
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});

const artifact = new deploy.BucketDeployment(stack, 'DeployApp', {
  sources: [deploy.Source.asset(path.join(__dirname, 'assets', 'nodejs.zip'))],
  destinationBucket: bucket,
  extract: false,
});

const serviceRole = new iam.Role(stack, 'service-role', {
  roleName: 'codepipeline-elasticbeanstalk-action-test-serivce-role',
  assumedBy: new iam.ServicePrincipal('elasticbeanstalk.amazonaws.com'),
  managedPolicies: [
    {
      managedPolicyArn: 'arn:aws:iam::aws:policy/service-role/AWSElasticBeanstalkEnhancedHealth',
    },
    {
      managedPolicyArn: 'arn:aws:iam::aws:policy/AWSElasticBeanstalkManagedUpdatesCustomerRolePolicy',
    },
  ],
});

const instanceProfileRole = new iam.Role(stack, 'instance-profile-role', {
  roleName: 'codepipeline-elasticbeanstalk-action-test-instance-profile-role',
  assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
  managedPolicies: [
    {
      managedPolicyArn: 'arn:aws:iam::aws:policy/AWSElasticBeanstalkWebTier',
    },
    {
      managedPolicyArn: 'arn:aws:iam::aws:policy/AWSElasticBeanstalkMulticontainerDocker',
    },
    {
      managedPolicyArn: 'arn:aws:iam::aws:policy/AWSElasticBeanstalkWorkerTier',
    },
  ],
});

const instanceProfile = new iam.CfnInstanceProfile(stack, 'instance-profile', {
  roles: [instanceProfileRole.roleName],
  instanceProfileName: instanceProfileRole.roleName,
});

const beanstalkApp = new elasticbeanstalk.CfnApplication(stack, 'beastalk-app', {
  applicationName: 'codepipeline-test-app',
});

const beanstalkEnv = new elasticbeanstalk.CfnEnvironment(stack, 'beanstlk-env', {
  applicationName: beanstalkApp.applicationName!,
  environmentName: 'codepipeline-test-env',
  // see https://docs.aws.amazon.com/elasticbeanstalk/latest/platforms/platforms-supported.html#platforms-supported.nodejs
  solutionStackName: '64bit Amazon Linux 2023 v6.5.2 running Node.js 20',
  optionSettings: [
    {
      namespace: 'aws:autoscaling:launchconfiguration',
      optionName: 'IamInstanceProfile',
      value: instanceProfile.instanceProfileName,
    },
    {
      namespace: 'aws:elasticbeanstalk:environment',
      optionName: 'ServiceRole',
      value: serviceRole.roleName,
    },
    {
      namespace: 'aws:elasticbeanstalk:environment',
      optionName: 'LoadBalancerType',
      value: 'application',
    },
    {
      namespace: 'aws:elasticbeanstalk:managedactions',
      optionName: 'ServiceRoleForManagedUpdates',
      value: 'AWSServiceRoleForElasticBeanstalkManagedUpdates',
    },
  ],
});

beanstalkEnv.addDependency(instanceProfile);
beanstalkEnv.addDependency(beanstalkApp);

const pipeline = new codepipeline.Pipeline(stack, 'Pipeline', {
  artifactBucket: bucket,
});

const sourceOutput = new codepipeline.Artifact('SourceArtifact-issue-27117');
const sourceAction = new cpactions.S3SourceAction({
  actionName: 'Source',
  output: sourceOutput,
  bucket,
  bucketKey: Fn.select(0, artifact.objectKeys),
});

pipeline.addStage({
  stageName: 'Source',
  actions: [
    sourceAction,
  ],
});

const deployAction = new cpactions.ElasticBeanstalkDeployAction({
  actionName: 'Deploy',
  input: sourceOutput,
  environmentName: beanstalkEnv.environmentName!,
  applicationName: beanstalkApp.applicationName!,
});

pipeline.addStage({
  stageName: 'Deploy',
  actions: [
    deployAction,
  ],
});

new integ.IntegTest(app, 'codepipeline-elastic-beanstalk-deploy', {
  testCases: [stack],
  diffAssets: true,
  stackUpdateWorkflow: false,
});

app.synth();
