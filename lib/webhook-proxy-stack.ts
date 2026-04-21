import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';

interface CodeBuildTarget {
  name: string;
  payloadUrl: string;
  secret: string;
}

interface WebhookProxyStackProps extends cdk.StackProps {
  githubWebhookSecret: string;
  targets: CodeBuildTarget[];
}

export class WebhookProxyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WebhookProxyStackProps) {
    super(scope, id, props);

    // Store GitHub webhook secret in Secrets Manager
    const githubSecret = new secretsmanager.Secret(this, 'GitHubWebhookSecret', {
      secretName: '/github-webhook-proxy/github-secret',
      secretStringValue: cdk.SecretValue.unsafePlainText(props.githubWebhookSecret),
      description: 'GitHub organization webhook secret for signature validation',
    });

    // Store each CodeBuild target config in SSM Parameter Store
    const targetNames: string[] = [];
    for (const target of props.targets) {
      const paramPrefix = `/github-webhook-proxy/targets/${target.name}`;

      new ssm.StringParameter(this, `Target-${target.name}-url`, {
        parameterName: `${paramPrefix}/payloadUrl`,
        stringValue: target.payloadUrl,
        description: `CodeBuild webhook URL for ${target.name}`,
      });

      new ssm.StringParameter(this, `Target-${target.name}-secret`, {
        parameterName: `${paramPrefix}/secret`,
        stringValue: target.secret,
        description: `CodeBuild webhook secret for ${target.name}`,
      });

      targetNames.push(target.name);
    }

    // Store the list of target names so Lambda knows what to look up
    new ssm.StringParameter(this, 'TargetList', {
      parameterName: '/github-webhook-proxy/target-list',
      stringValue: JSON.stringify(targetNames),
      description: 'List of registered CodeBuild target names',
    });

    // Lambda function
    const proxyFn = new lambda.Function(this, 'WebhookProxyFunction', {
      functionName: 'GitHubWebhookProxy',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda')),
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        GITHUB_SECRET_ARN: githubSecret.secretArn,
        TARGET_LIST_PARAM: '/github-webhook-proxy/target-list',
        TARGET_PARAM_PREFIX: '/github-webhook-proxy/targets',
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    // Grant Lambda read access to secrets and parameters
    githubSecret.grantRead(proxyFn);
    proxyFn.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParametersByPath'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/github-webhook-proxy/*`,
      ],
    }));

    // API Gateway
    const api = new apigateway.RestApi(this, 'WebhookApi', {
      restApiName: 'GitHub Webhook Proxy',
      description: 'Receives GitHub org webhooks and fans out to CodeBuild projects',
      deployOptions: {
        stageName: 'prod',
        throttlingRateLimit: 100,
        throttlingBurstLimit: 200,
      },
    });

    const webhookResource = api.root.addResource('webhook');
    webhookResource.addMethod('POST', new apigateway.LambdaIntegration(proxyFn, {
      proxy: true,
    }));

    // Outputs
    new cdk.CfnOutput(this, 'WebhookUrl', {
      value: `${api.url}webhook`,
      description: 'Configure this URL as the GitHub organization webhook Payload URL',
    });

    new cdk.CfnOutput(this, 'TargetCount', {
      value: `${props.targets.length}`,
      description: 'Number of CodeBuild targets registered',
    });
  }
}
