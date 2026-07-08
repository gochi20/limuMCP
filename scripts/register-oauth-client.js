#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const portalBaseUrl = (process.env.LIMU_PORTAL_BASE_URL || 'https://portal.limu.co.mw').replace(/\/+$/, '');
const clientId = process.env.LIMU_OAUTH_CLIENT_ID || 'limu-vercel-mcp';
const clientName = process.env.LIMU_OAUTH_CLIENT_NAME || 'LIMU MCP on Vercel';
const clientSecret = process.env.LIMU_OAUTH_CLIENT_SECRET || '';
const redirectUris = (process.env.LIMU_OAUTH_REDIRECT_URIS || process.env.LIMU_OAUTH_REDIRECT_URI || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const allowedScopes = [
  'profile:read',
  'clients:read',
  'clients:write',
  'cargo:read',
  'packages:read',
  'shipments:read',
  'budgets:read',
  'budgets:write',
  'requisitions:read',
  'requisitions:review',
  'requisitions:delete',
  'payment_vouchers:read',
  'payment_vouchers:review',
  'payment_vouchers:pay',
  'payment_vouchers:delete',
  'leave:read',
  'leave:review',
  'offline_access',
];

async function portalFetch(pathname, options = {}) {
  const response = await fetch(`${portalBaseUrl}${pathname}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

async function loadAdminToken() {
  if (process.env.LIMU_ADMIN_TOKEN) {
    return process.env.LIMU_ADMIN_TOKEN;
  }

  const email = process.env.LIMU_ADMIN_EMAIL || '';
  const password = process.env.LIMU_ADMIN_PASSWORD || '';
  if (!email || !password) {
    throw new Error('Set LIMU_ADMIN_TOKEN or LIMU_ADMIN_EMAIL/LIMU_ADMIN_PASSWORD in .env.');
  }

  const login = await portalFetch('/Api/v1/auth/login/', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  if (!login.token) {
    throw new Error('Portal login did not return a bearer token.');
  }
  return login.token;
}

if (redirectUris.length === 0) {
  console.error('Set LIMU_OAUTH_REDIRECT_URI or LIMU_OAUTH_REDIRECT_URIS before registering the client.');
  process.exit(1);
}

try {
  const token = await loadAdminToken();
  const body = {
    client_id: clientId,
    name: clientName,
    redirect_uris: redirectUris,
    allowed_scopes: allowedScopes,
    is_confidential: Boolean(clientSecret),
  };
  if (clientSecret) {
    body.client_secret = clientSecret;
  }

  const result = await portalFetch('/Api/v1/oauth/clients/', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  console.log(JSON.stringify(result, null, 2));
  console.log('\nUse these Vercel environment variables:');
  console.log(`LIMU_PORTAL_BASE_URL=${portalBaseUrl}`);
  console.log(`LIMU_OAUTH_ISSUER=${portalBaseUrl}/Api/v1/oauth`);
  console.log(`LIMU_OAUTH_CLIENT_ID=${clientId}`);
  if (clientSecret) {
    console.log('LIMU_OAUTH_CLIENT_SECRET=<the secret you provided>');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
