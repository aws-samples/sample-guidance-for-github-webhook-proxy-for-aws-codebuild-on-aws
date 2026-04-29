// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';
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
    // URLs use standard StringParameter; secrets use SecureString (KMS-encrypted)
    const targetNames: string[] = [];
    for (const target of props.targets) {
      const paramPrefix = `/github-webhook-proxy/targets/${target.name}`;

      new ssm.StringParameter(this, `Target-${target.name}-url`, {
        parameterName: `${paramPrefix}/payloadUrl`,
        stringValue: target.payloadUrl,
        description: `CodeBuild webhook URL for ${target.name}`,
      });

      // Use SecureString via CfnParameter for KMS-encrypted storage at rest.
      // CDK L2 StringParameter does not support SecureString, so we use L1.
      new cdk.CfnResource(this, `Target-${target.name}-secret`, {
        type: 'AWS::SSM::Parameter',
        properties: {
          Name: `${paramPrefix}/secret`,
          Type: 'SecureString',
          Value: target.secret,
          Description: `CodeBuild webhook secret for ${target.name}`,
        },
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
    const lambdaLogGroup = new logs.LogGroup(this, 'LambdaLogGroup', {
      logGroupName: '/aws/lambda/GitHubWebhookProxy',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

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
      logGroup: lambdaLogGroup,
    });

    // Grant Lambda read access to secrets and parameters
    githubSecret.grantRead(proxyFn);
    proxyFn.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParametersByPath'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/github-webhook-proxy/*`,
      ],
    }));
    // Allow decryption of SecureString parameters (uses the default AWS-managed SSM key)
    proxyFn.addToRolePolicy(new cdk.aws_iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: [
        `arn:aws:kms:${this.region}:${this.account}:alias/aws/ssm`,
      ],
    }));

    // API Gateway with access logging
    const logGroup = new logs.LogGroup(this, 'ApiAccessLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
    });

    const api = new apigateway.RestApi(this, 'WebhookApi', {
      restApiName: 'GitHub Webhook Proxy',
      description: 'Receives GitHub org webhooks and fans out to CodeBuild projects',
      deployOptions: {
        stageName: 'prod',
        throttlingRateLimit: 100,
        throttlingBurstLimit: 200,
        accessLogDestination: new apigateway.LogGroupLogDestination(logGroup),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
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

    // cdk-nag suppressions for patterns that are acceptable in this context
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-APIG1',
        reason: 'Access logging is enabled via deployOptions.accessLogDestination',
      },
      {
        id: 'AwsSolutions-APIG2',
        reason: 'Request validation is handled by the Lambda function which validates the GitHub HMAC signature',
      },
      {
        id: 'AwsSolutions-APIG4',
        reason: 'This API receives GitHub webhook events which use HMAC signature authentication, not AWS auth',
      },
      {
        id: 'AwsSolutions-COG4',
        reason: 'Cognito authorizer is not applicable — GitHub authenticates via HMAC-SHA256 signatures',
      },
      {
        id: 'AwsSolutions-IAM4',
        reason: 'Lambda basic execution managed policy is acceptable for CloudWatch Logs access',
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Wildcard is scoped to /github-webhook-proxy/* SSM parameter path prefix',
      },
      {
        id: 'AwsSolutions-SMG4',
        reason: 'Secret rotation is not applicable — the GitHub webhook secret is a shared static secret',
      },
      {
        id: 'AwsSolutions-APIG3',
        reason: 'WAF is recommended as a next step but not required for this Guidance deployment',
      },
      {
        id: 'AwsSolutions-L1',
        reason: 'Node.js 20.x is the latest supported Lambda runtime at time of publishing',
      },
    ]);
  }
}