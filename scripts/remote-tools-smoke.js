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
const reassignCargoClient = tools.get('limu_reassign_cargo_client');
const correctCargoTotals = tools.get('limu_correct_cargo_totals');
const correctBookedCargoTotals = tools.get('limu_correct_booked_cargo_totals');
const reconcileCargoPackages = tools.get('limu_reconcile_cargo_packages');
const getCargoActionAudit = tools.get('limu_get_cargo_action_audit');
const listCargoContentCategories = tools.get('limu_list_cargo_content_categories');
const updatePackage = tools.get('limu_update_package');
assert.ok(createCargo, 'limu_create_cargo was not registered.');
assert.ok(createPackage, 'limu_create_package was not registered.');
assert.ok(mergeCargo, 'limu_merge_cargo was not registered.');
assert.ok(assignCargoShipment, 'limu_assign_cargo_shipment was not registered.');
assert.ok(syncCargoPackageCount, 'limu_sync_cargo_package_count was not registered.');
assert.ok(reassignCargoClient, 'limu_reassign_cargo_client was not registered.');
assert.ok(correctCargoTotals, 'limu_correct_cargo_totals was not registered.');
assert.ok(correctBookedCargoTotals, 'limu_correct_booked_cargo_totals was not registered.');
assert.ok(reconcileCargoPackages, 'limu_reconcile_cargo_packages was not registered.');
assert.ok(getCargoActionAudit, 'limu_get_cargo_action_audit was not registered.');
assert.ok(listCargoContentCategories, 'limu_list_cargo_content_categories was not registered.');
assert.ok(updatePackage, 'limu_update_package was not registered.');
assert.equal(updatePackage.definition.annotations.readOnlyHint, false);
assert.equal(updatePackage.definition.annotations.idempotentHint, true);
assert.equal(createCargo.definition.annotations.readOnlyHint, false);
assert.equal(createPackage.definition.annotations.readOnlyHint, false);
assert.equal(mergeCargo.definition.annotations.destructiveHint, true);
assert.equal(assignCargoShipment.definition.annotations.idempotentHint, true);
assert.equal(syncCargoPackageCount.definition.annotations.idempotentHint, true);
assert.equal(reassignCargoClient.definition.annotations.idempotentHint, true);
assert.equal(correctCargoTotals.definition.annotations.idempotentHint, true);
assert.equal(correctBookedCargoTotals.definition.annotations.idempotentHint, true);
assert.equal(reconcileCargoPackages.definition.annotations.destructiveHint, true);
assert.equal(getCargoActionAudit.definition.annotations.readOnlyHint, true);

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
    body: options.body === undefined ? undefined : JSON.parse(options.body),
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
  await reassignCargoClient.handler({
    cargoId: 91,
    expectedCurrentClientId: 41,
    targetClientId: 42,
    dryRun: true,
    confirm: false,
  }, extra);
  await correctCargoTotals.handler({
    cargoId: 91,
    expectedWeight: 25.5,
    expectedVolume: 1.25,
    expectedPackageCount: 3,
    proposedWeight: 24.5,
    proposedVolume: 1.2,
    proposedPackageCount: 2,
    dryRun: true,
    confirm: false,
  }, extra);
  await reconcileCargoPackages.handler({
    targetCargoId: 91,
    packageMoves: [{ packageId: 501, expectedSourceCargoId: 92 }],
    deduplications: [{ deletePackageId: 502, keepPackageId: 503 }],
    dryRun: true,
    confirm: false,
  }, extra);
  await correctBookedCargoTotals.handler({
    cargoId: 91,
    expectedShipmentId: 213,
    expectedWeight: 25.5,
    expectedVolume: 1.25,
    expectedPackageCount: 3,
    proposedWeight: 24.5,
    proposedVolume: 1.2,
    proposedPackageCount: 2,
    dryRun: true,
    confirm: false,
  }, extra);
  await getCargoActionAudit.handler({
    idempotencyKey: 'gat013-merge-7124-20260810-v1',
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
  {
    url: 'https://portal.limu.co.mw/Api/v1/cargo/reassign-client.php',
    method: 'POST',
    authorization: 'Bearer test-token',
    body: {
      cargoId: 91,
      expectedCurrentClientId: 41,
      targetClientId: 42,
      dryRun: true,
      confirm: false,
    },
  },
  {
    url: 'https://portal.limu.co.mw/Api/v1/cargo/correct-totals.php',
    method: 'POST',
    authorization: 'Bearer test-token',
    body: {
      cargoId: 91,
      expectedWeight: 25.5,
      expectedVolume: 1.25,
      expectedPackageCount: 3,
      proposedWeight: 24.5,
      proposedVolume: 1.2,
      proposedPackageCount: 2,
      dryRun: true,
      confirm: false,
    },
  },
  {
    url: 'https://portal.limu.co.mw/Api/v1/cargo/reconcile-packages.php',
    method: 'POST',
    authorization: 'Bearer test-token',
    body: {
      targetCargoId: 91,
      packageMoves: [{ packageId: 501, expectedSourceCargoId: 92 }],
      deduplications: [{ deletePackageId: 502, keepPackageId: 503 }],
      dryRun: true,
      confirm: false,
    },
  },
  {
    url: 'https://portal.limu.co.mw/Api/v1/cargo/correct-booked-totals.php',
    method: 'POST',
    authorization: 'Bearer test-token',
    body: {
      cargoId: 91,
      expectedShipmentId: 213,
      expectedWeight: 25.5,
      expectedVolume: 1.25,
      expectedPackageCount: 3,
      proposedWeight: 24.5,
      proposedVolume: 1.2,
      proposedPackageCount: 2,
      dryRun: true,
      confirm: false,
    },
  },
  {
    url: 'https://portal.limu.co.mw/Api/v1/cargo/action-audit.php?idempotencyKey=gat013-merge-7124-20260810-v1',
    method: 'GET',
    authorization: 'Bearer test-token',
    body: undefined,
  },
]);

// Cargo content-category listing + package content/category update. Verified in
// an isolated fetch mock so they don't disturb the ordered `requests` sequence.
{
  const extra = { authInfo: { token: 'test-token' } };
  const calls = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({
      url: String(url),
      method: options.method,
      body: options.body === undefined ? undefined : JSON.parse(options.body),
    });
    return Response.json({ status: 200, message: 'ok' }, { status: 200 });
  };
  try {
    // An update with neither content nor contentId has nothing to change.
    await assert.rejects(
      () => updatePackage.handler({ packageId: 501, confirm: true }, extra),
      /at least one of content or contentId/,
    );

    // Dry run returns the current package alongside the proposed change.
    const preview = JSON.parse(
      (await updatePackage.handler({ packageId: 501, content: 'Sports shoes', contentId: 4, confirm: false }, extra)).content[0].text,
    );
    assert.equal(preview.confirmationRequired, true);
    assert.deepEqual(preview.proposedUpdate, { content: 'Sports shoes', contentId: 4 });

    // Confirmed update PUTs only the changed fields to the package endpoint.
    calls.length = 0;
    await updatePackage.handler({ packageId: 501, content: 'Sports shoes', contentId: 4, confirm: true }, extra);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'PUT');
    assert.match(calls[0].url, /\/Api\/v1\/cargo\/packages\/update\.php\?id=501$/);
    assert.deepEqual(calls[0].body, { content: 'Sports shoes', contentId: 4 });

    // Category listing reads the cargo-content catalog.
    calls.length = 0;
    await listCargoContentCategories.handler({}, extra);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
    assert.match(calls[0].url, /\/Api\/v1\/settings\/cargo-content\/$/);
  } finally {
    globalThis.fetch = savedFetch;
  }
}

console.log(JSON.stringify({
  ok: true,
  registeredToolCount: tools.size,
  testedTools: ['limu_create_cargo', 'limu_create_package', 'limu_merge_cargo', 'limu_assign_cargo_shipment', 'limu_sync_cargo_package_count', 'limu_reassign_cargo_client', 'limu_correct_cargo_totals', 'limu_correct_booked_cargo_totals', 'limu_reconcile_cargo_packages', 'limu_get_cargo_action_audit', 'limu_list_cargo_content_categories', 'limu_update_package'],
}, null, 2));
