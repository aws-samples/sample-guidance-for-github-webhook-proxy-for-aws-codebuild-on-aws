#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { WebhookProxyStack } from '../lib/webhook-proxy-stack';
import * as targets from '../config/targets.json';

const app = new cdk.App();

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
  description: 'GitHub Webhook Proxy for CodeBuild - fans out 1 org webhook to N CodeBuild projects',
});
