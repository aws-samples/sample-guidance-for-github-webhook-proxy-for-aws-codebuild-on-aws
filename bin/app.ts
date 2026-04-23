#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { WebhookProxyStack } from '../lib/webhook-proxy-stack';
import * as targets from '../config/targets.json';

const app = new cdk.App();

// Enable cdk-nag AwsSolutions checks
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

const githubWebhookSecret = app.node.tryGetContext('githubWebhookSecret');
if (!githubWebhookSecret) {
  throw new Error(
    'Missing required context: githubWebhookSecret. ' +
    'Deploy with: npx cdk deploy --context githubWebhookSecret=YOUR_SECRET'
  );
}

new WebhookProxyStack(app, 'GitHubWebhookProxyStack', {
  githubWebhookSecret,
  targets: targets.targets,
  description: 'Guidance for GitHub Webhook Proxy for AWS CodeBuild on AWS (SO9999)',
});
