// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { createHmac, timingSafeEqual } from 'crypto';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import {
  SSMClient,
  GetParameterCommand,
  GetParametersByPathCommand,
} from '@aws-sdk/client-ssm';

const smClient = new SecretsManagerClient();
const ssmClient = new SSMClient();

// Cache loaded config for warm starts
let cachedGitHubSecret = null;
let cachedTargets = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Load the GitHub webhook secret from Secrets Manager.
 */
async function getGitHubSecret() {
  if (cachedGitHubSecret && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedGitHubSecret;
  }
  const resp = await smClient.send(new GetSecretValueCommand({
    SecretId: process.env.GITHUB_SECRET_ARN,
  }));
  cachedGitHubSecret = resp.SecretString;
  cacheTimestamp = Date.now();
  return cachedGitHubSecret;
}

/**
 * Load all CodeBuild targets from SSM Parameter Store.
 * Returns array of { name, payloadUrl, secret }.
 */
async function getTargets() {
  if (cachedTargets && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedTargets;
  }

  // Get the list of target names
  const listResp = await ssmClient.send(new GetParameterCommand({
    Name: process.env.TARGET_LIST_PARAM,
  }));
  const targetNames = JSON.parse(listResp.Parameter.Value);

  // Fetch all target parameters in batch (WithDecryption for SecureString secrets)
  const prefix = process.env.TARGET_PARAM_PREFIX;
  const allParams = [];
  let nextToken;
  do {
    const resp = await ssmClient.send(new GetParametersByPathCommand({
      Path: `${prefix}/`,
      Recursive: true,
      WithDecryption: true,
      NextToken: nextToken,
    }));
    allParams.push(...(resp.Parameters || []));
    nextToken = resp.NextToken;
  } while (nextToken);

  // Build target objects
  const targets = targetNames.map((name) => {
    const urlParam = allParams.find(p => p.Name === `${prefix}/${name}/payloadUrl`);
    const secretParam = allParams.find(p => p.Name === `${prefix}/${name}/secret`);
    return {
      name,
      payloadUrl: urlParam?.Value,
      secret: secretParam?.Value,
    };
  }).filter(t => t.payloadUrl && t.secret);

  cachedTargets = targets;
  return targets;
}

/**
 * Validate the GitHub webhook signature (X-Hub-Signature-256).
 */
function validateGitHubSignature(payload, signatureHeader, secret) {
  if (!signatureHeader) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Sign a payload with a CodeBuild webhook secret and forward it.
 * Retries up to 2 times on transient 5xx failures with exponential backoff.
 */
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 500;

async function forwardToTarget(target, body, githubHeaders) {
  const signature = createHmac('sha256', target.secret)
    .update(body)
    .digest('hex');

  const headers = {
    'Content-Type': 'application/json',
    'X-Hub-Signature-256': `sha256=${signature}`,
  };

  // Forward relevant GitHub headers
  const forwardHeaders = [
    'X-GitHub-Event',
    'X-GitHub-Delivery',
    'X-GitHub-Hook-ID',
  ];
  for (const h of forwardHeaders) {
    const lowerH = h.toLowerCase();
    if (githubHeaders[lowerH]) {
      headers[h] = githubHeaders[lowerH];
    }
  }

  let lastResp;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    lastResp = await fetch(target.payloadUrl, {
      method: 'POST',
      headers,
      body,
    });

    // Success or client error (4xx) — don't retry
    if (lastResp.ok || lastResp.status < 500) {
      break;
    }

    // Transient 5xx — retry with exponential backoff
    if (attempt < MAX_RETRIES) {
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
      console.warn(`Target ${target.name} returned ${lastResp.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  return {
    name: target.name,
    status: lastResp.status,
    ok: lastResp.ok,
  };
}

export async function handler(event) {
  console.log('Received webhook event');

  const body = event.body || '';
  const headers = {};
  // Normalize header keys to lowercase
  if (event.headers) {
    for (const [k, v] of Object.entries(event.headers)) {
      headers[k.toLowerCase()] = v;
    }
  }

  // Validate GitHub signature
  const githubSecret = await getGitHubSecret();
  const signature = headers['x-hub-signature-256'];

  if (!validateGitHubSignature(body, signature, githubSecret)) {
    console.error('Invalid GitHub webhook signature');
    return {
      statusCode: 401,
      body: JSON.stringify({ error: 'Invalid signature' }),
    };
  }

  const githubEvent = headers['x-github-event'] || 'unknown';
  const deliveryId = headers['x-github-delivery'] || 'unknown';
  console.log(`GitHub event: ${githubEvent}, delivery: ${deliveryId}`);

  // Handle GitHub ping event
  if (githubEvent === 'ping') {
    console.log('Ping event received — webhook is configured correctly');
    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'pong', deliveryId }),
    };
  }

  // Load targets and fan out
  const targets = await getTargets();
  console.log(`Forwarding to ${targets.length} CodeBuild targets`);

  const results = await Promise.allSettled(
    targets.map(target => forwardToTarget(target, body, headers))
  );

  const summary = results.map((r, i) => {
    if (r.status === 'fulfilled') {
      return { name: r.value.name, status: r.value.status, ok: r.value.ok };
    }
    return { name: targets[i].name, status: 'error', ok: false, error: r.reason?.message };
  });

  const succeeded = summary.filter(s => s.ok).length;
  const failed = summary.filter(s => !s.ok).length;

  console.log(`Results: ${succeeded} succeeded, ${failed} failed`);
  if (failed > 0) {
    console.error('Failed targets:', JSON.stringify(summary.filter(s => !s.ok)));
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      event: githubEvent,
      deliveryId,
      targets: targets.length,
      succeeded,
      failed,
      details: summary,
    }),
  };
}
