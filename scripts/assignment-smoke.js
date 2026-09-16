import assert from 'node:assert/strict';
import { z } from 'zod';
import { registerRemoteTools } from '../src/remote-tools.js';
const tools = new Map();
registerRemoteTools({ registerTool(name, definition, handler) { tools.set(name, { definition, handler }); } });
const tool = tools.get('limu_assign_cargo_shipment');
assert.ok(tool);
const schema = z.object(tool.definition.inputSchema);
const base = { cargoId: 91, shipmentId: 213 };
assert.equal(schema.parse(base).dryRun, true);
assert.equal(schema.parse(base).confirm, false);
for (const invalid of [{ cargoId: 0 }, { shipmentId: 1.5 }, { confirm: 'true' }, { previewToken: 'bad' }]) {
  assert.equal(schema.safeParse({ ...base, ...invalid }).success, false);
}
const originalFetch = globalThis.fetch;
const requests = [];
let fail = false;
globalThis.fetch = async (url, options) => {
  assert.ok(String(url).endsWith('/Api/v1/cargo/assign-shipment.php'));
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.Authorization, 'Bearer test-token');
  const body = JSON.parse(options.body);
  requests.push(body);
  if (fail) return Response.json({ message: 'The assignment preview is stale.' }, { status: 409 });
  return Response.json(body.dryRun ? { eligible: true, previewToken: 'a'.repeat(64) } : { cargoStatus: 'Booked', idempotentReplay: requests.length === 3 });
};
try {
  const extra = { authInfo: { token: 'test-token' } };
  await assert.rejects(() => tool.handler(base), /OAuth bearer token/);
  await assert.rejects(() => tool.handler({ ...base, dryRun: false, confirm: true }, extra), /previewToken and idempotencyKey/);
  assert.equal(requests.length, 0);
  const preview = JSON.parse((await tool.handler(base, extra)).content[0].text);
  assert.equal(requests[0].dryRun, true);
  assert.equal(requests[0].confirm, false);
  const confirmed = { ...base, dryRun: false, confirm: true, previewToken: preview.previewToken, idempotencyKey: 'assign-91-213' };
  const saved = JSON.parse((await tool.handler(confirmed, extra)).content[0].text);
  assert.equal(saved.cargoStatus, 'Booked');
  const retry = JSON.parse((await tool.handler(confirmed, extra)).content[0].text);
  assert.equal(retry.idempotentReplay, true);
  assert.deepEqual(requests[1], requests[2]);
  fail = true;
  await assert.rejects(() => tool.handler(confirmed, extra), /preview is stale/);
} finally { globalThis.fetch = originalFetch; }
console.log('Assignment preview defaults, validation, authorization, execution, retry forwarding and conflict checks passed.');
