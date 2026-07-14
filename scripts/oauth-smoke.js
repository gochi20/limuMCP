#!/usr/bin/env node

import assert from 'node:assert/strict';
import { GET as protectedResourceMetadata } from '../app/.well-known/oauth-protected-resource/route.js';
import {
  LIMU_OAUTH_SCOPES,
  mcpResourceUrl,
  verifyLimuToken,
} from '../src/portal-api.js';

const serverUrl = 'https://limu-mcp.vercel.app/api/mcp';
assert.equal(mcpResourceUrl(serverUrl), serverUrl);
assert.equal(mcpResourceUrl(new Request(serverUrl)), serverUrl);

const metadataResponse = await protectedResourceMetadata(
  new Request('https://limu-mcp.vercel.app/.well-known/oauth-protected-resource')
);
assert.equal(metadataResponse.status, 200);
const metadata = await metadataResponse.json();
assert.equal(metadata.resource, serverUrl);
assert.deepEqual(metadata.authorization_servers, ['https://portal.limu.co.mw/Api/v1/oauth']);
assert.deepEqual(metadata.scopes_supported, LIMU_OAUTH_SCOPES);

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => Response.json({
  sub: 'employee:42',
  aud: serverUrl,
  scope: 'profile:read clients:read',
  expires_at: '2030-01-01 00:00:00',
});

try {
  const authInfo = await verifyLimuToken('valid-token', serverUrl);
  assert.equal(authInfo?.clientId, 'employee:42');
  assert.deepEqual(authInfo?.scopes, ['profile:read', 'clients:read']);
  assert.equal(typeof authInfo?.expiresAt, 'number');

  const wrongAudience = await verifyLimuToken('valid-token', 'https://other.example/api/mcp');
  assert.equal(wrongAudience, undefined);
} finally {
  globalThis.fetch = originalFetch;
}

console.log(JSON.stringify({
  ok: true,
  resource: metadata.resource,
  scopeCount: metadata.scopes_supported.length,
}, null, 2));
