#!/usr/bin/env node

import assert from 'node:assert/strict';
import { registerRemoteTools } from '../src/remote-tools.js';

const tools = new Map();
registerRemoteTools({
  registerTool(name, definition, handler) {
    tools.set(name, { definition, handler });
  },
});

const createCargo = tools.get('limu_create_cargo');
const createPackage = tools.get('limu_create_package');
const mergeCargo = tools.get('limu_merge_cargo');
const assignCargoShipment = tools.get('limu_assign_cargo_shipment');
const syncCargoPackageCount = tools.get('limu_sync_cargo_package_count');
assert.ok(createCargo, 'limu_create_cargo was not registered.');
assert.ok(createPackage, 'limu_create_package was not registered.');
assert.ok(mergeCargo, 'limu_merge_cargo was not registered.');
assert.ok(assignCargoShipment, 'limu_assign_cargo_shipment was not registered.');
assert.ok(syncCargoPackageCount, 'limu_sync_cargo_package_count was not registered.');
assert.equal(createCargo.definition.annotations.readOnlyHint, false);
assert.equal(createPackage.definition.annotations.readOnlyHint, false);
assert.equal(mergeCargo.definition.annotations.destructiveHint, true);
assert.equal(assignCargoShipment.definition.annotations.idempotentHint, true);
assert.equal(syncCargoPackageCount.definition.annotations.idempotentHint, true);

const cargoArgs = {
  clientId: 42,
  shipmentId: 7,
  location: 'Blantyre',
  weight: 25.5,
  volume: 1.25,
  packageCount: 3,
  content: 'Electronics',
  financeStatus: 'Pending Payment',
  consignmentValue: 1200,
};
const packageArgs = {
  cargoId: 91,
  contentId: 4,
  content: 'Laptop computers',
  quantity: 3,
  packageType: 'box',
  courierTrackingNumber: 'DHL-123',
};

const cargoPreview = JSON.parse((await createCargo.handler({ ...cargoArgs, confirm: false })).content[0].text);
assert.equal(cargoPreview.confirmationRequired, true);
assert.equal(cargoPreview.proposedCargo.packages, 3);

const packagePreview = JSON.parse((await createPackage.handler({ ...packageArgs, confirm: false })).content[0].text);
assert.equal(packagePreview.confirmationRequired, true);
assert.deepEqual(packagePreview.proposedPackage, packageArgs);

const originalFetch = globalThis.fetch;
const requests = [];
globalThis.fetch = async (url, options) => {
  requests.push({
    url: String(url),
    method: options.method,
    authorization: options.headers.Authorization,
    body: JSON.parse(options.body),
  });
  return Response.json({ status: 201, message: 'Created.' }, { status: 201 });
};

try {
  const extra = { authInfo: { token: 'test-token' } };
  await createCargo.handler({ ...cargoArgs, confirm: true }, extra);
  await createPackage.handler({ ...packageArgs, confirm: true }, extra);
  await mergeCargo.handler({
    primaryCargoId: 91,
    sourceCargoIds: [92, 93],
    dryRun: true,
    confirm: false,
  }, extra);
  await assignCargoShipment.handler({
    cargoId: 91,
    shipmentId: 213,
    dryRun: true,
    confirm: false,
  }, extra);
  await syncCargoPackageCount.handler({
    cargoId: 91,
    expectedCurrentCount: 13,
    expectedPackageQuantity: 7,
    dryRun: true,
    confirm: false,
  }, extra);
} finally {
  globalThis.fetch = originalFetch;
}

assert.deepEqual(requests, [
  {
    url: 'https://portal.limu.co.mw/Api/v1/cargo/create.php',
    method: 'POST',
    authorization: 'Bearer test-token',
    body: {
      clientId: 42,
      shipmentId: 7,
      location: 'Blantyre',
      weight: 25.5,
      volume: 1.25,
      packages: 3,
      content: 'Electronics',
      financeStatus: 'Pending Payment',
      consignmentValue: 1200,
    },
  },
  {
    url: 'https://portal.limu.co.mw/Api/v1/cargo/packages/create.php',
    method: 'POST',
    authorization: 'Bearer test-token',
    body: packageArgs,
  },
  {
    url: 'https://portal.limu.co.mw/Api/v1/cargo/merge.php',
    method: 'POST',
    authorization: 'Bearer test-token',
    body: {
      primaryCargoId: 91,
      sourceCargoIds: [92, 93],
      dryRun: true,
      confirm: false,
    },
  },
  {
    url: 'https://portal.limu.co.mw/Api/v1/cargo/assign-shipment.php',
    method: 'POST',
    authorization: 'Bearer test-token',
    body: {
      cargoId: 91,
      shipmentId: 213,
      dryRun: true,
      confirm: false,
    },
  },
  {
    url: 'https://portal.limu.co.mw/Api/v1/cargo/sync-package-count.php',
    method: 'POST',
    authorization: 'Bearer test-token',
    body: {
      cargoId: 91,
      expectedCurrentCount: 13,
      expectedPackageQuantity: 7,
      dryRun: true,
      confirm: false,
    },
  },
]);

console.log(JSON.stringify({
  ok: true,
  registeredToolCount: tools.size,
  testedTools: ['limu_create_cargo', 'limu_create_package', 'limu_merge_cargo', 'limu_assign_cargo_shipment', 'limu_sync_cargo_package_count'],
}, null, 2));
