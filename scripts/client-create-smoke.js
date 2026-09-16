import assert from 'node:assert/strict';
import { z } from 'zod';
import { registerRemoteTools } from '../src/remote-tools.js';
const tools = new Map();
registerRemoteTools({ registerTool(name, definition, handler) { tools.set(name, { definition, handler }); } });
for (const name of ['limu_create_client', 'limu_create_cargo', 'limu_create_package', 'limu_merge_cargo']) assert.ok(tools.has(name), name);
const merge = tools.get('limu_merge_cargo');
await assert.rejects(() => merge.handler({ primaryCargoId: 1, sourceCargoIds: [2], dryRun: false, confirm: true }), /previewToken and idempotencyKey/);
const tool = tools.get('limu_create_client');
const schema = z.object(tool.definition.inputSchema);
const input = schema.parse({ firstName: "O'Neil", lastName: 'Test', phone: '+265888123456' });
assert.equal(input.dryRun, true);
assert.equal(input.confirm, false);
assert.equal(schema.safeParse({ ...input, email: 'invalid' }).success, false);
const originalFetch = globalThis.fetch;
let calls = 0;
globalThis.fetch = async (url, options) => {
  calls++;
  assert.ok(String(url).endsWith('/Api/v1/clients/create.php'));
  assert.equal(options.headers.Authorization, 'Bearer test-token');
  assert.equal(options.method, 'POST');
  const body = JSON.parse(options.body);
  if (calls === 1) {
    assert.equal(body.dryRun, true);
    return Response.json({ dryRun: true, proposedClient: body });
  }
  assert.equal(body.confirm, true);
  assert.equal(body.dryRun, false);
  return Response.json({ message: 'A client with this phone or email already exists.' }, { status: 409 });
};
try {
  await assert.rejects(() => tool.handler(input), /OAuth bearer token/);
  assert.equal(calls, 0);
  const preview = await tool.handler(input, { authInfo: { token: 'test-token' } });
  assert.equal(JSON.parse(preview.content[0].text).dryRun, true);
  await assert.rejects(() => tool.handler({ ...input, dryRun: false, confirm: true }, { authInfo: { token: 'test-token' } }), /already exists/);
} finally { globalThis.fetch = originalFetch; }
console.log('All four workflow tools registered; client preview, auth, validation and conflict handling passed.');
