# GitHub Webhook Proxy for CodeBuild

A ready-to-deploy AWS CDK solution that proxies a single GitHub organization webhook to multiple AWS CodeBuild projects across multiple accounts, solving the GitHub 20-webhook-per-org limit.

## Architecture

```
GitHub Org Webhook → API Gateway → Lambda → N CodeBuild Projects (across M accounts)
```

### Components
- **API Gateway** — HTTPS endpoint that receives GitHub webhook events
- **Lambda** — Validates the GitHub signature, then forwards the payload to all registered CodeBuild webhook endpoints
- **SSM Parameter Store** — Stores CodeBuild project webhook URLs and secrets
- **Secrets Manager** — Stores the GitHub webhook secret for signature validation

## Prerequisites

- Node.js 18+
- AWS CDK v2 installed (`npm install -g aws-cdk`)
- AWS credentials configured for the account where you want to deploy the proxy
- CodeBuild projects created with `manualCreation: true` in their webhook config

## Setup

### 1. Install dependencies

```bash
cd github-webhook-proxy
npm install
```

### 2. Register CodeBuild projects

For each CodeBuild project, you need the `payloadUrl` and `secret` that CodeBuild generated when the project was created with `manualCreation: true`.

Add them to `config/targets.json`:

```json
{
  "targets": [
    {
      "name": "account1-project-alpha",
      "payloadUrl": "https://codebuild.us-east-1.amazonaws.com/webhooks/...",
      "secret": "the-codebuild-webhook-secret"
    },
    {
      "name": "account2-project-beta",
      "payloadUrl": "https://codebuild.ap-southeast-2.amazonaws.com/webhooks/...",
      "secret": "another-codebuild-webhook-secret"
    }
  ]
}
```

### 3. Set your GitHub webhook secret

```bash
export GITHUB_WEBHOOK_SECRET="your-chosen-secret"
```

### 4. Deploy

```bash
npx cdk deploy --context githubWebhookSecret=$GITHUB_WEBHOOK_SECRET
```

### 5. Configure GitHub

1. Go to your GitHub Organization → Settings → Webhooks → Add webhook
2. Set **Payload URL** to the API Gateway endpoint output from the CDK deploy
3. Set **Content type** to `application/json`
4. Set **Secret** to the same `GITHUB_WEBHOOK_SECRET` you used above
5. Select events: **Workflow jobs** (and any other events your CodeBuild projects need)

## How It Works

1. GitHub sends a webhook event to the API Gateway endpoint
2. Lambda validates the `X-Hub-Signature-256` header against the stored GitHub secret
3. For each registered CodeBuild target, Lambda:
   - Re-signs the payload using that target's CodeBuild webhook secret
   - Forwards the full payload + headers to the target's `payloadUrl`
4. Lambda returns a summary of successes/failures

## Managing Targets

### Adding a new CodeBuild project

1. Add the new target to `config/targets.json`
2. Run `npx cdk deploy` to update the SSM parameters

### Removing a CodeBuild project

1. Remove it from `config/targets.json`
2. Run `npx cdk deploy`

## Monitoring

- Lambda logs are in CloudWatch Logs at `/aws/lambda/GitHubWebhookProxy`
- API Gateway access logs are enabled
- Failed forwarding attempts are logged with the target name and HTTP status

## Cost Estimate

For ~1000 webhook events/day across 60 CodeBuild projects:
- API Gateway: ~$3.50/month
- Lambda: ~$0.50/month (well within free tier)
- Secrets Manager: ~$0.40/month
- SSM Parameter Store: Free (standard tier)

**Total: ~$5/month**
