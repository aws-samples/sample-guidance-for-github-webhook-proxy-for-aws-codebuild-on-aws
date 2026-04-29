# User Guide — GitHub Webhook Proxy for AWS CodeBuild

This guide walks you through deploying, configuring, operating, and troubleshooting the GitHub Webhook Proxy.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Getting Your CodeBuild Webhook Credentials](#getting-your-codebuild-webhook-credentials)
3. [Configuring Targets](#configuring-targets)
4. [Deploying the Proxy](#deploying-the-proxy)
5. [Configuring the GitHub Organization Webhook](#configuring-the-github-organization-webhook)
6. [Verifying the Setup](#verifying-the-setup)
7. [Day-to-Day Operations](#day-to-day-operations)
8. [Monitoring and Logging](#monitoring-and-logging)
9. [Security](#security)
10. [Troubleshooting](#troubleshooting)
11. [FAQ](#faq)

---

## Prerequisites

Before you begin, ensure you have:

- **Node.js 18.x or later** — [Download](https://nodejs.org/)
- **AWS CDK v2** — Install globally: `npm install -g aws-cdk`
- **AWS CLI** — Configured with credentials for the account where you want to deploy the proxy
- **CDK Bootstrap** — If this is your first CDK deployment in the target account/Region:
  ```bash
  cdk bootstrap aws://ACCOUNT_ID/REGION
  ```
- **GitHub Organization admin access** — Required to create organization-level webhooks

---

## Getting Your CodeBuild Webhook Credentials

Each CodeBuild project you want to receive webhook events must be created with **manual webhook creation** enabled. This gives you a `payloadUrl` and `secret` that the proxy uses to forward events.

### For new CodeBuild projects

When creating a CodeBuild project via the console or CLI, enable the webhook with `manualCreation: true`:

```bash
aws codebuild create-project \
  --name my-project \
  --source type=GITHUB,location=https://github.com/my-org/my-repo.git,buildspec=buildspec.yml \
  --environment type=LINUX_CONTAINER,computeType=BUILD_GENERAL1_SMALL,image=aws/codebuild/amazonlinux2-x86_64-standard:5.0 \
  --service-role arn:aws:iam::ACCOUNT_ID:role/codebuild-role

aws codebuild create-webhook \
  --project-name my-project \
  --build-type BUILD \
  --manual-creation
```

The `create-webhook` response includes:
- `payloadUrl` — The HTTPS endpoint CodeBuild listens on
- `secret` — The HMAC secret for signature validation

Save both values — you'll need them in the next step.

### For existing CodeBuild projects

If the project already has a webhook, you can retrieve the `payloadUrl` from:

```bash
aws codebuild batch-get-projects --names my-project \
  --query "projects[0].webhook.{payloadUrl: payloadUrl}"
```

> **Note:** The `secret` is only shown once at creation time. If you've lost it, delete and recreate the webhook with `--manual-creation`.

---

## Configuring Targets

Edit `config/targets.json` to register your CodeBuild projects:

```json
{
  "targets": [
    {
      "name": "account1-team-alpha",
      "payloadUrl": "https://codebuild.us-east-1.amazonaws.com/webhooks/trigger?t=eyJ...",
      "secret": "codebuild-webhook-secret-1"
    },
    {
      "name": "account2-team-beta",
      "payloadUrl": "https://codebuild.ap-southeast-2.amazonaws.com/webhooks/trigger?t=eyJ...",
      "secret": "codebuild-webhook-secret-2"
    }
  ]
}
```

### Target fields

| Field | Description |
|---|---|
| `name` | A unique, descriptive identifier (e.g., `prod-us-east-1-api-service`). Used as the SSM parameter path segment. |
| `payloadUrl` | The CodeBuild webhook URL from `create-webhook --manual-creation`. |
| `secret` | The CodeBuild webhook secret from `create-webhook --manual-creation`. |

### Naming conventions

Use a consistent naming pattern for targets:
- `{account-alias}-{region}-{project-name}`
- `{team}-{service}-{environment}`

---

## Deploying the Proxy

### 1. Install dependencies

```bash
npm install
```

### 2. Choose a GitHub webhook secret

Pick a strong, random secret. You'll configure the same value in GitHub later.

```bash
export GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 32)
echo "Save this secret: $GITHUB_WEBHOOK_SECRET"
```

### 3. Deploy

```bash
npx cdk deploy --context githubWebhookSecret=$GITHUB_WEBHOOK_SECRET
```

CDK outputs the API Gateway webhook URL:

```
Outputs:
GitHubWebhookProxyStack.WebhookUrl = https://abc123.execute-api.us-east-1.amazonaws.com/prod/webhook
GitHubWebhookProxyStack.TargetCount = 2
```

Save the `WebhookUrl` — you'll need it for GitHub configuration.

### 4. Verify the stack

```bash
aws cloudformation describe-stacks \
  --stack-name GitHubWebhookProxyStack \
  --query "Stacks[0].StackStatus"
```

Expected: `"CREATE_COMPLETE"`

---

## Configuring the GitHub Organization Webhook

1. Go to your GitHub Organization → **Settings** → **Webhooks** → **Add webhook**
2. Set **Payload URL** to the `WebhookUrl` from the CDK output
3. Set **Content type** to `application/json`
4. Set **Secret** to the same `GITHUB_WEBHOOK_SECRET` you used during deployment
5. Under **Which events would you like to trigger this webhook?**, select:
   - **Workflow jobs** (required for CodeBuild)
   - Any other events your CodeBuild projects filter on (e.g., pushes, pull requests)
6. Ensure **Active** is checked
7. Click **Add webhook**

GitHub immediately sends a `ping` event to verify connectivity.

---

## Verifying the Setup

### Check the ping event

After adding the webhook in GitHub, check CloudWatch Logs:

```bash
aws logs filter-log-events \
  --log-group-name /aws/lambda/GitHubWebhookProxy \
  --filter-pattern "pong" \
  --limit 5
```

You should see a log entry with `"message": "pong"`.

### Trigger a real event

Push a commit to any repository in your GitHub organization:

```bash
git commit --allow-empty -m "test: Trigger webhook proxy"
git push
```

Then check the logs:

```bash
aws logs filter-log-events \
  --log-group-name /aws/lambda/GitHubWebhookProxy \
  --filter-pattern "succeeded" \
  --limit 5
```

### Verify CodeBuild received the event

Check your CodeBuild project for a triggered build:

```bash
aws codebuild list-builds-for-project \
  --project-name my-project \
  --sort-order DESCENDING \
  --query "ids[0]"
```

---

## Day-to-Day Operations

### Adding a new CodeBuild target

1. Get the `payloadUrl` and `secret` from CodeBuild (see [Getting Your CodeBuild Webhook Credentials](#getting-your-codebuild-webhook-credentials))
2. Add the new entry to `config/targets.json`
3. Redeploy:
   ```bash
   npx cdk deploy --context githubWebhookSecret=$GITHUB_WEBHOOK_SECRET
   ```

### Removing a CodeBuild target

1. Remove the entry from `config/targets.json`
2. Redeploy:
   ```bash
   npx cdk deploy --context githubWebhookSecret=$GITHUB_WEBHOOK_SECRET
   ```
3. Manually clean up the orphaned SSM parameters:
   ```bash
   aws ssm delete-parameter --name /github-webhook-proxy/targets/TARGET_NAME/payloadUrl
   aws ssm delete-parameter --name /github-webhook-proxy/targets/TARGET_NAME/secret
   ```

### Updating the GitHub webhook secret

1. Generate a new secret
2. Redeploy with the new secret:
   ```bash
   npx cdk deploy --context githubWebhookSecret=NEW_SECRET
   ```
3. Update the secret in GitHub Organization → Settings → Webhooks → Edit

> **Important:** Update both sides (AWS and GitHub) quickly to minimize failed deliveries during the transition.

---

## Monitoring and Logging

### Lambda execution logs

- **Log group:** `/aws/lambda/GitHubWebhookProxy`
- **Retention:** 30 days
- Each invocation logs: event type, delivery ID, number of targets, success/failure counts

### API Gateway access logs

- **Log group:** Created automatically by the stack
- **Format:** JSON with standard fields (request ID, IP, method, status, latency)

### Key log patterns to monitor

| Pattern | Meaning |
|---|---|
| `"succeeded": N, "failed": 0` | All targets received the event |
| `"failed": N` | One or more targets failed — check the `details` array |
| `Invalid GitHub webhook signature` | Signature mismatch — verify the secret matches between GitHub and AWS |
| `Ping event received` | GitHub connectivity check succeeded |

### Recommended CloudWatch Alarms

```bash
# Alarm on Lambda errors
aws cloudwatch put-metric-alarm \
  --alarm-name GitHubWebhookProxy-Errors \
  --metric-name Errors \
  --namespace AWS/Lambda \
  --dimensions Name=FunctionName,Value=GitHubWebhookProxy \
  --statistic Sum \
  --period 300 \
  --threshold 1 \
  --comparison-operator GreaterThanOrEqualToThreshold \
  --evaluation-periods 1 \
  --alarm-actions arn:aws:sns:REGION:ACCOUNT_ID:your-topic
```

---

## Security

### How signature validation works

1. GitHub signs every webhook payload with HMAC-SHA256 using your organization webhook secret
2. The proxy Lambda retrieves the secret from AWS Secrets Manager and validates the `X-Hub-Signature-256` header
3. If validation fails, the request is rejected with HTTP 401
4. For each CodeBuild target, the Lambda re-signs the payload using that target's individual secret before forwarding

### Secrets storage

| Secret | Storage | Path |
|---|---|---|
| GitHub webhook secret | AWS Secrets Manager | `/github-webhook-proxy/github-secret` |
| CodeBuild target URLs | SSM Parameter Store | `/github-webhook-proxy/targets/{name}/payloadUrl` |
| CodeBuild target secrets | SSM Parameter Store | `/github-webhook-proxy/targets/{name}/secret` |
| Target name list | SSM Parameter Store | `/github-webhook-proxy/target-list` |

### API Gateway throttling

- **Rate limit:** 100 requests/second
- **Burst limit:** 200 requests

### cdk-nag compliance

The stack includes [cdk-nag](https://github.com/cdklabs/cdk-nag) with the AwsSolutions rule pack. All suppressions are documented with justifications in `lib/webhook-proxy-stack.ts`.

---

## Troubleshooting

### GitHub shows "Last delivery was not successful"

1. Check CloudWatch Logs for the Lambda function
2. Look for `Invalid GitHub webhook signature` — the secret may not match
3. Verify the API Gateway endpoint is reachable

### Builds not triggering on CodeBuild

1. Confirm the target's `payloadUrl` is correct in `config/targets.json`
2. Check CloudWatch Logs for `"failed"` entries in the response
3. Verify the CodeBuild webhook was created with `--manual-creation`
4. Ensure the CodeBuild project's webhook filter matches the event type (e.g., `PUSH`, `PULL_REQUEST_CREATED`)

### HTTP 401 from the proxy

The GitHub webhook secret doesn't match. Verify:
```bash
# Check what's stored in Secrets Manager
aws secretsmanager get-secret-value \
  --secret-id /github-webhook-proxy/github-secret \
  --query SecretString --output text
```
Compare with the secret configured in GitHub → Organization → Settings → Webhooks.

### Lambda timeout (60s)

If you have many targets (50+), the Lambda may approach its 60-second timeout. Options:
- Increase the timeout in `lib/webhook-proxy-stack.ts` (max 900s)
- The proxy already uses `Promise.allSettled` for parallel forwarding, so targets are called concurrently

### Stale target configuration

The Lambda caches target configurations for 5 minutes. After redeploying with new targets, the first invocation within the cache window may use old config. Wait up to 5 minutes or trigger a test event.

---

## FAQ

**Q: Can I use this with GitHub Enterprise Server?**
A: Yes. The proxy validates standard GitHub webhook signatures (`X-Hub-Signature-256`), which work the same way on GitHub Enterprise Server.

**Q: Can I deploy this in a different Region than my CodeBuild projects?**
A: Yes. The proxy forwards events over HTTPS to CodeBuild webhook URLs, which are Region-specific public endpoints. The proxy can run in any Region.

**Q: What happens if a CodeBuild target is temporarily unavailable?**
A: The proxy logs the failure but continues forwarding to all other targets. GitHub does not retry individual target failures — only the initial delivery to the proxy is retried by GitHub.

**Q: How many targets can I register?**
A: There is no hard limit. The proxy forwards to all targets concurrently using `Promise.allSettled`. For very large numbers (100+), consider increasing the Lambda timeout.

**Q: Does this work with repository-level webhooks?**
A: This Guidance is designed for organization-level webhooks, but it works with repository-level webhooks too. The signature validation is identical.
