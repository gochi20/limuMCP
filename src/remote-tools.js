import { z } from 'zod';
import { jsonToolResult, portalRequest, tokenFromAuthInfo } from './portal-api.js';

const optionalText = z.string().trim().optional();
const optionalId = z.number().int().positive().optional();
const optionalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.').optional();
const optionalMonth = z.string().regex(/^\d{4}-\d{2}$/, 'Use YYYY-MM.').optional();
const limitSchema = z.number().int().min(1).max(100).default(25);
const offsetSchema = z.number().int().min(0).default(0);
const nonNegativeMeasurement = z.number().finite().min(0).max(1000000000);
const packageTypeSchema = z.enum([
  'box',
  'pallet',
  'carton',
  'crate',
  'bundle',
  'bag',
  'roll',
  'piece',
  'other',
]);
const actionKeySchema = z.string().trim().regex(
  /^[A-Za-z0-9._:-]{8,120}$/,
  'Use a stable 8-120 character key with letters, numbers, dots, underscores, colons, or hyphens.'
).optional();
const previewTokenSchema = z.string().trim().regex(/^[a-f0-9]{64}$/, 'Use the SHA-256 preview token returned by the latest dry run.').optional();
const budgetFilters = {
  budgetEntryId: optionalId,
  budgetMonth: optionalMonth,
  categoryId: optionalId,
  category: optionalText,
  currency: optionalText,
  search: optionalText,
};
const quickbooksId = z.coerce.string().trim().regex(/^\d{1,30}$/, 'Use a QuickBooks numeric ID.');
const quickbooksAmount = z.number().positive().max(1000000000);
const quickbooksCurrency = z.string().trim().regex(/^[A-Za-z]{3}$/, 'Use a three-letter currency code.').transform((value) => value.toUpperCase()).optional();
const quickbooksPostingFields = {
  txnDate: optionalDate,
  dueDate: optionalDate,
  currency: quickbooksCurrency,
  docNumber: z.string().trim().max(21).optional(),
  privateNote: z.string().trim().max(3600).optional(),
  sourceReference: z.string().trim().regex(/^[A-Za-z0-9._:-]{4,120}$/, 'Use a stable source reference with letters, numbers, dots, underscores, colons, or hyphens.'),
  idempotencyKey: z.string().trim().regex(/^[A-Za-z0-9._:-]{4,120}$/, 'Use a stable idempotency key with letters, numbers, dots, underscores, colons, or hyphens.'),
  dryRun: z.boolean().default(true),
  confirm: z.boolean().default(false),
};
const quickbooksSalesLine = z.object({
  itemId: quickbooksId,
  amount: quickbooksAmount,
  description: z.string().trim().max(1000).optional(),
  quantity: z.number().positive().max(1000000).optional(),
  unitPrice: quickbooksAmount.optional(),
});
const quickbooksExpenseLine = z.object({
  accountId: quickbooksId,
  amount: quickbooksAmount,
  description: z.string().trim().max(1000).optional(),
});
const quickbooksApplication = z.object({
  id: quickbooksId,
  amount: quickbooksAmount,
});

function authToken(extra) {
  return tokenFromAuthInfo(extra?.authInfo);
}

function notMigrated(toolName, endpoint) {
  return jsonToolResult({
    ok: false,
    tool: toolName,
    message: 'This MCP tool is registered, but the matching LIMU Portal API endpoint is not built yet.',
    requiredPortalEndpoint: endpoint,
  });
}

export function registerRemoteTools(server) {
  server.registerTool(
    'limu_health',
    {
      title: 'LIMU health',
      description: 'Check the remote LIMU OAuth session and portal API metadata.',
      inputSchema: {},
    },
    async (_args, extra) => {
      const token = authToken(extra);
      const [oauth, user] = await Promise.all([
        portalRequest('/Api/v1/oauth/', { token }),
        portalRequest('/Api/v1/oauth/userinfo/', { token }),
      ]);
      return jsonToolResult({ ok: true, oauth, user });
    }
  );

  server.registerTool(
    'limu_get_clients',
    {
      title: 'Get clients',
      description: 'Get clients through the LIMU Portal API using the authenticated user permissions.',
      inputSchema: {
        clientId: optionalId,
        limit: limitSchema,
        offset: offsetSchema,
      },
    },
    async ({ clientId, limit, offset }, extra) => {
      const data = await portalRequest('/Api/v1/clients/', {
        token: authToken(extra),
        query: { id: clientId },
      });
      const rows = Array.isArray(data?.Data) ? data.Data : [];
      return jsonToolResult({
        ...data,
        Data: clientId ? rows : rows.slice(offset, offset + limit),
        pagination: clientId ? null : { limit, offset, returned: rows.slice(offset, offset + limit).length, total: rows.length },
      });
    }
  );

  server.registerTool(
    'limu_get_client',
    {
      title: 'Get client',
      description: 'Get one client through the LIMU Portal API.',
      inputSchema: {
        clientId: z.number().int().positive(),
      },
    },
    async ({ clientId }, extra) => {
      const data = await portalRequest('/Api/v1/clients/', {
        token: authToken(extra),
        query: { id: clientId },
      });
      return jsonToolResult(data);
    }
  );

  server.registerTool(
    'limu_update_client',
    {
      title: 'Update client',
      description: 'Update a client through the LIMU Portal API. Portal permissions remain authoritative.',
      inputSchema: {
        userid: z.number().int().positive(),
        firstname: optionalText,
        lastname: optionalText,
        email: optionalText,
        phonenumber: optionalText,
        gender: optionalText,
        business: optionalText,
        businesscategory: optionalText,
        location: optionalText,
      },
    },
    async (args, extra) => {
      const data = await portalRequest('/Api/v1/clients/', {
        token: authToken(extra),
        method: 'PUT',
        body: args,
      });
      return jsonToolResult(data);
    }
  );

  server.registerTool(
    'limu_list_cargo',
    {
      title: 'List cargo',
      description: 'List cargo through the LIMU Portal API.',
      inputSchema: {
        clientId: optionalId,
        limit: limitSchema,
        offset: offsetSchema,
      },
    },
    async ({ clientId, limit, offset }, extra) => {
      const data = await portalRequest('/Api/v1/cargo/', {
        token: authToken(extra),
        query: { clientid: clientId },
      });
      const rows = Array.isArray(data?.Data) ? data.Data : [];
      return jsonToolResult({
        ...data,
        Data: rows.slice(offset, offset + limit),
        pagination: { limit, offset, returned: rows.slice(offset, offset + limit).length, total: rows.length },
      });
    }
  );

  server.registerTool(
    'limu_get_cargo',
    {
      title: 'Get cargo',
      description: 'Get one cargo record through the LIMU Portal API.',
      inputSchema: {
        cargoId: z.number().int().positive(),
      },
    },
    async ({ cargoId }, extra) => {
      const data = await portalRequest('/Api/v1/cargo/', {
        token: authToken(extra),
        query: { id: cargoId },
      });
      return jsonToolResult(data);
    }
  );

  server.registerTool(
    'limu_create_cargo',
    {
      title: 'Create cargo',
      description: 'Preview or create a cargo record through the LIMU Portal API. The authenticated employee must have Cargo create permission. Set confirm=true only after the proposed cargo details have been approved.',
      inputSchema: {
        clientId: z.number().int().positive(),
        shipmentId: optionalId,
        location: z.string().trim().min(1).max(255),
        weight: nonNegativeMeasurement.default(0),
        volume: nonNegativeMeasurement.default(0),
        packageCount: z.number().int().min(0).max(1000000).default(0),
        content: z.string().trim().max(1000).optional(),
        financeStatus: z.string().trim().min(1).max(100).default('Pending Payment'),
        consignmentValue: z.number().finite().min(0).max(1000000000).optional(),
        confirm: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ confirm, packageCount, ...cargo }, extra) => {
      const proposedCargo = {
        clientId: cargo.clientId,
        shipmentId: cargo.shipmentId,
        location: cargo.location,
        weight: cargo.weight,
        volume: cargo.volume,
        packages: packageCount,
        content: cargo.content,
        financeStatus: cargo.financeStatus,
        consignmentValue: cargo.consignmentValue,
      };
      if (!confirm) {
        return jsonToolResult({
          ok: false,
          confirmationRequired: true,
          message: 'Review proposedCargo, then call limu_create_cargo again with confirm=true to create it.',
          proposedCargo,
        });
      }

      const data = await portalRequest('/Api/v1/cargo/create.php', {
        token: authToken(extra),
        method: 'POST',
        body: proposedCargo,
      });
      return jsonToolResult(data);
    }
  );

  server.registerTool(
    'limu_merge_cargo',
    {
      title: 'Preview or merge cargo',
      description: 'Preview a same-client merge of Created, unassigned cargo or execute an approved preview. Confirmed merges move related records into the primary cargo and delete the source cargo records. Always run dryRun=true first, then reuse its previewToken with confirm=true, dryRun=false, and a stable idempotencyKey.',
      inputSchema: {
        primaryCargoId: z.number().int().positive(),
        sourceCargoIds: z.array(z.number().int().positive()).min(1).max(50),
        dryRun: z.boolean().default(true),
        confirm: z.boolean().default(false),
        previewToken: previewTokenSchema,
        idempotencyKey: actionKeySchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async (args, extra) => {
      if (!args.dryRun && args.confirm && (!args.previewToken || !args.idempotencyKey)) {
        throw new Error('Confirmed merges require previewToken and idempotencyKey from an approved dry run.');
      }
      const data = await portalRequest('/Api/v1/cargo/merge.php', {
        token: authToken(extra),
        method: 'POST',
        body: args,
      });
      return jsonToolResult(data);
    }
  );

  server.registerTool(
    'limu_assign_cargo_shipment',
    {
      title: 'Preview or assign cargo to shipment',
      description: 'Preview assignment of one Created, unassigned cargo record to a shipment or execute an approved preview. A confirmed assignment changes cargo status to Booked and records shipment activity. Always run dryRun=true first, then reuse its previewToken with confirm=true, dryRun=false, and a stable idempotencyKey.',
      inputSchema: {
        cargoId: z.number().int().positive(),
        shipmentId: z.number().int().positive(),
        dryRun: z.boolean().default(true),
        confirm: z.boolean().default(false),
        previewToken: previewTokenSchema,
        idempotencyKey: actionKeySchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args, extra) => {
      if (!args.dryRun && args.confirm && (!args.previewToken || !args.idempotencyKey)) {
        throw new Error('Confirmed assignments require previewToken and idempotencyKey from an approved dry run.');
      }
      const data = await portalRequest('/Api/v1/cargo/assign-shipment.php', {
        token: authToken(extra),
        method: 'POST',
        body: args,
      });
      return jsonToolResult(data);
    }
  );

  server.registerTool(
    'limu_sync_cargo_package_count',
    {
      title: 'Sync cargo package count',
      description: 'Preview or correct one Created, unassigned cargo record whose declared package count differs from the live sum of its package units. Execution requires the exact expected current and package-unit counts, a fresh preview token, explicit confirmation, and an idempotency key.',
      inputSchema: {
        cargoId: z.number().int().positive(),
        expectedCurrentCount: z.number().int().min(0).max(1000000),
        expectedPackageQuantity: z.number().int().min(0).max(1000000),
        dryRun: z.boolean().default(true),
        confirm: z.boolean().default(false),
        previewToken: previewTokenSchema,
        idempotencyKey: actionKeySchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args, extra) => {
      if (!args.dryRun && args.confirm && (!args.previewToken || !args.idempotencyKey)) {
        throw new Error('Confirmed package-count corrections require previewToken and idempotencyKey from an approved dry run.');
      }
      const data = await portalRequest('/Api/v1/cargo/sync-package-count.php', {
        token: authToken(extra),
        method: 'POST',
        body: args,
      });
      return jsonToolResult(data);
    }
  );

  server.registerTool(
    'limu_reassign_cargo_client',
    {
      title: 'Correct cargo client ownership',
      description: 'Preview or correct the client owner of one Created, unassigned cargo record. Execution requires the exact current client ID, a fresh preview token, explicit confirmation, and an idempotency key.',
      inputSchema: {
        cargoId: z.number().int().positive(),
        expectedCurrentClientId: z.number().int().positive(),
        targetClientId: z.number().int().positive(),
        dryRun: z.boolean().default(true),
        confirm: z.boolean().default(false),
        previewToken: previewTokenSchema,
        idempotencyKey: actionKeySchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args, extra) => {
      if (!args.dryRun && args.confirm && (!args.previewToken || !args.idempotencyKey)) {
        throw new Error('Confirmed client corrections require previewToken and idempotencyKey from an approved dry run.');
      }
      const data = await portalRequest('/Api/v1/cargo/reassign-client.php', {
        token: authToken(extra),
        method: 'POST',
        body: args,
      });
      return jsonToolResult(data);
    }
  );

  server.registerTool(
    'limu_correct_cargo_totals',
    {
      title: 'Correct cargo totals',
      description: 'Preview or correct weight, volume, and declared package count for one Created, unassigned cargo. The exact current totals are required and package-unit differences are reported as warnings before execution.',
      inputSchema: {
        cargoId: z.number().int().positive(),
        expectedWeight: nonNegativeMeasurement,
        expectedVolume: nonNegativeMeasurement,
        expectedPackageCount: z.number().int().min(0).max(1000000),
        proposedWeight: nonNegativeMeasurement,
        proposedVolume: nonNegativeMeasurement,
        proposedPackageCount: z.number().int().min(0).max(1000000),
        dryRun: z.boolean().default(true),
        confirm: z.boolean().default(false),
        previewToken: previewTokenSchema,
        idempotencyKey: actionKeySchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args, extra) => {
      if (!args.dryRun && args.confirm && (!args.previewToken || !args.idempotencyKey)) {
        throw new Error('Confirmed totals corrections require previewToken and idempotencyKey from an approved dry run.');
      }
      const data = await portalRequest('/Api/v1/cargo/correct-totals.php', {
        token: authToken(extra),
        method: 'POST',
        body: args,
      });
      return jsonToolResult(data);
    }
  );

  server.registerTool(
    'limu_correct_booked_cargo_totals',
    {
      title: 'Correct Booked cargo totals',
      description: 'Preview or correct weight, volume, and declared package count for one Booked cargo that is already assigned to a shipment. Use this only when limu_correct_cargo_totals refuses because the cargo is no longer Created/unassigned. The exact current totals and the exact current shipment ID are required. The shipping-cost recomputes from the shipment pricing snapshot against the corrected totals and the client shipment summary is refreshed; package-unit differences are reported as warnings before execution.',
      inputSchema: {
        cargoId: z.number().int().positive(),
        expectedShipmentId: z.number().int().positive(),
        expectedWeight: nonNegativeMeasurement,
        expectedVolume: nonNegativeMeasurement,
        expectedPackageCount: z.number().int().min(0).max(1000000),
        proposedWeight: nonNegativeMeasurement,
        proposedVolume: nonNegativeMeasurement,
        proposedPackageCount: z.number().int().min(0).max(1000000),
        dryRun: z.boolean().default(true),
        confirm: z.boolean().default(false),
        previewToken: previewTokenSchema,
        idempotencyKey: actionKeySchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args, extra) => {
      if (!args.dryRun && args.confirm && (!args.previewToken || !args.idempotencyKey)) {
        throw new Error('Confirmed Booked totals corrections require previewToken and idempotencyKey from an approved dry run.');
      }
      const data = await portalRequest('/Api/v1/cargo/correct-booked-totals.php', {
        token: authToken(extra),
        method: 'POST',
        body: args,
      });
      return jsonToolResult(data);
    }
  );

  server.registerTool(
    'limu_reconcile_cargo_packages',
    {
      title: 'Reconcile cargo package groups',
      description: 'Preview or execute whole-package-group moves and exact tracking-number deduplication across Created, unassigned cargo owned by the same client. Partial-unit splits and checked packages are rejected.',
      inputSchema: {
        targetCargoId: z.number().int().positive(),
        packageMoves: z.array(z.object({
          packageId: z.number().int().positive(),
          expectedSourceCargoId: z.number().int().positive(),
        })).max(500).default([]),
        deduplications: z.array(z.object({
          deletePackageId: z.number().int().positive(),
          keepPackageId: z.number().int().positive(),
        })).max(500).default([]),
        dryRun: z.boolean().default(true),
        confirm: z.boolean().default(false),
        previewToken: previewTokenSchema,
        idempotencyKey: actionKeySchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async (args, extra) => {
      if (!args.dryRun && args.confirm && (!args.previewToken || !args.idempotencyKey)) {
        throw new Error('Confirmed package reconciliations require previewToken and idempotencyKey from an approved dry run.');
      }
      const data = await portalRequest('/Api/v1/cargo/reconcile-packages.php', {
        token: authToken(extra),
        method: 'POST',
        body: args,
      });
      return jsonToolResult(data);
    }
  );

  server.registerTool(
    'limu_get_cargo_action_audit',
    {
      title: 'Get cargo action audit',
      description: 'Read the sanitized audit status and server-side error for one guarded cargo action by its exact idempotency key. This does not expose request bodies, response tokens, or credentials.',
      inputSchema: {
        idempotencyKey: actionKeySchema,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ idempotencyKey }, extra) => {
      const data = await portalRequest('/Api/v1/cargo/action-audit.php', {
        token: authToken(extra),
        query: { idempotencyKey },
      });
      return jsonToolResult(data);
    }
  );

  server.registerTool(
    'limu_list_packages',
    {
      title: 'List packages',
      description: 'List packages for a cargo record through the LIMU Portal API.',
      inputSchema: {
        cargoId: z.number().int().positive(),
      },
    },
    async ({ cargoId }, extra) => {
      const data = await portalRequest('/Api/v1/cargo/packages/', {
        token: authToken(extra),
        query: { cargoId },
      });
      return jsonToolResult(data);
    }
  );

  server.registerTool(
    'limu_create_package',
    {
      title: 'Create cargo package',
      description: 'Preview or create a package group for existing cargo through the LIMU Portal API. The authenticated employee must have Cargo create permission. The portal generates the package code and unit records. Set confirm=true only after approval.',
      inputSchema: {
        cargoId: z.number().int().positive(),
        contentId: z.number().int().positive(),
        content: z.string().trim().min(1).max(255),
        quantity: z.number().int().positive().max(1000000),
        packageType: packageTypeSchema,
        courierTrackingNumber: z.string().trim().min(1).max(100).optional(),
        confirm: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ confirm, ...proposedPackage }, extra) => {
      if (!confirm) {
        return jsonToolResult({
          ok: false,
          confirmationRequired: true,
          message: 'Review proposedPackage, then call limu_create_package again with confirm=true to create it.',
          proposedPackage,
        });
      }

      const data = await portalRequest('/Api/v1/cargo/packages/create.php', {
        token: authToken(extra),
        method: 'POST',
        body: proposedPackage,
      });
      return jsonToolResult(data);
    }
  );

  server.registerTool(
    'limu_get_package',
    {
      title: 'Get package',
      description: 'Get one package by id or package code through the LIMU Portal API.',
      inputSchema: {
        packageId: optionalId,
        packageCode: optionalText,
      },
    },
    async ({ packageId, packageCode }, extra) => {
      if (!packageId && !packageCode) {
        throw new Error('packageId or packageCode is required.');
      }
      const data = await portalRequest('/Api/v1/cargo/packages/', {
        token: authToken(extra),
        query: { id: packageId, packageCode },
      });
      return jsonToolResult(data);
    }
  );

  server.registerTool(
    'limu_list_shipments',
    {
      title: 'List shipments',
      description: 'List shipments through the LIMU Portal API.',
      inputSchema: {
        limit: limitSchema,
        offset: offsetSchema,
      },
    },
    async ({ limit, offset }, extra) => {
      const data = await portalRequest('/Api/v1/shipment/', {
        token: authToken(extra),
      });
      const rows = Array.isArray(data?.Data) ? data.Data : [];
      return jsonToolResult({
        ...data,
        Data: rows.slice(offset, offset + limit),
        pagination: { limit, offset, returned: rows.slice(offset, offset + limit).length, total: rows.length },
      });
    }
  );

  server.registerTool(
    'limu_get_shipment',
    {
      title: 'Get shipment',
      description: 'Get one shipment through the LIMU Portal API.',
      inputSchema: {
        shipmentId: z.number().int().positive(),
      },
    },
    async ({ shipmentId }, extra) => {
      const data = await portalRequest('/Api/v1/shipment/', {
        token: authToken(extra),
        query: { id: shipmentId },
      });
      return jsonToolResult(data);
    }
  );

  server.registerTool(
    'limu_get_imports_and_orders_report',
    {
      title: 'Imports and orders report',
      description: 'Report imported cargo by shipment arrival date and ordered goods by order creation date. Requires Cargo, Shipments, and Order Form Reports access in LIMU Portal.',
      inputSchema: {
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.'),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.'),
        limit: z.number().int().min(1).max(200).default(100),
      },
    },
    async ({ from, to, limit }, extra) => {
      const data = await portalRequest('/Api/v1/reports/imports-orders/', {
        token: authToken(extra),
        query: { from, to, limit },
      });
      return jsonToolResult(data);
    }
  );

  server.registerTool(
    'limu_get_import_product_report',
    {
      title: 'Import product report',
      description: 'Read the LIMU Portal Import Product Report: imported cargo categories, top importers, client-category rows, and import trend data. Requires Import Product Reports access in LIMU Portal.',
      inputSchema: {
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.'),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.'),
        productCategory: optionalText,
        categoryLimit: z.number().int().min(1).max(100).default(20),
        clientLimit: z.number().int().min(1).max(500).default(100),
        topImporterLimit: z.number().int().min(1).max(50).default(10),
      },
    },
    async ({ from, to, productCategory, categoryLimit, clientLimit, topImporterLimit }, extra) => {
      const data = await portalRequest('/Api/v1/reports/import-products/', {
        token: authToken(extra),
        query: { from, to, productCategory, categoryLimit, clientLimit, topImporterLimit },
      });
      return jsonToolResult(data);
    }
  );

  server.registerTool(
    'limu_get_leads_report',
    {
      title: 'Leads report',
      description: 'Read LIMU lead conversion, source, segment, tag, and pipeline analytics with paginated lead records. Requires Leads Reports access in LIMU Portal.',
      inputSchema: {
        from: optionalDate,
        to: optionalDate,
        search: optionalText,
        status: optionalText,
        segment: optionalText,
        source: optionalText,
        tag: optionalText,
        district: optionalText,
        ownerId: optionalId,
        onlyUnassignedOwner: z.boolean().default(false),
        trendGroup: z.enum(['daily', 'weekly', 'monthly']).default('monthly'),
        limit: limitSchema,
        offset: offsetSchema,
      },
    },
    async (args, extra) => {
      const data = await portalRequest('/Api/v1/reports/leads/', {
        token: authToken(extra),
        query: args,
      });
      return jsonToolResult(data);
    }
  );

  server.registerTool(
    'limu_get_client_profile_report',
    {
      title: 'Client profile report',
      description: 'Read active client profiles based on cargo activity, including demographics, tier, relations-officer coverage, and paginated client detail. Requires Client Profile Reports or Clients access in LIMU Portal.',
      inputSchema: {
        from: optionalDate,
        to: optionalDate,
        limit: limitSchema,
        offset: offsetSchema,
      },
    },
    async (args, extra) => {
      const data = await portalRequest('/Api/v1/reports/client-profiles/', {
        token: authToken(extra),
        query: args,
      });
      return jsonToolResult(data);
    }
  );

  server.registerTool(
    'limu_list_monthly_budgets',
    {
      title: 'List monthly budgets',
      description: 'List monthly budget entries through the LIMU Portal API.',
      inputSchema: {
        ...budgetFilters,
        limit: limitSchema,
        offset: offsetSchema,
      },
    },
    async (args, extra) => {
      const data = await portalRequest('/Api/v1/mcp/monthly-budgets/', {
        token: authToken(extra),
        query: args,
      });
      return jsonToolResult(data);
    }
  );

  server.registerTool(
    'limu_get_monthly_budget',
    {
      title: 'Get monthly budget',
      description: 'Get a monthly budget period or entry through the LIMU Portal API.',
      inputSchema: {
        ...budgetFilters,
        includeScheduleSplits: z.boolean().default(true),
        includeUsage: z.boolean().default(false),
        linkedLimit: limitSchema,
        limit: limitSchema,
        offset: offsetSchema,
      },
    },
    async (args, extra) => {
      const data = await portalRequest('/Api/v1/mcp/monthly-budgets/', {
        token: authToken(extra),
        query: args,
      });
      return jsonToolResult(data);
    }
  );

  server.registerTool(
    'limu_get_budget_report',
    {
      title: 'Budget report',
      description: 'Get a monthly budget report with totals by currency/category and purchase schedule coverage.',
      inputSchema: {
        ...budgetFilters,
      },
    },
    async (args, extra) => {
      const data = await portalRequest('/Api/v1/mcp/budget-report/', {
        token: authToken(extra),
        query: args,
      });
      return jsonToolResult(data);
    }
  );

  server.registerTool(
    'limu_list_purchase_schedule',
    {
      title: 'List purchase schedule',
      description: 'List scheduled budget purchases through the LIMU Portal API.',
      inputSchema: {
        ...budgetFilters,
        scheduledFrom: optionalDate,
        scheduledTo: optionalDate,
        limit: limitSchema,
        offset: offsetSchema,
      },
    },
    async (args, extra) => {
      const data = await portalRequest('/Api/v1/mcp/purchase-schedule/', {
        token: authToken(extra),
        query: args,
      });
      return jsonToolResult(data);
    }
  );

  server.registerTool(
    'limu_schedule_budget_purchase',
    {
      title: 'Schedule budget purchase',
      description: 'Set, clear, add, update, or delete purchase schedule rows through the LIMU Portal API.',
      inputSchema: {
        action: z.enum(['set_single_date', 'clear_single_date', 'add_split', 'update_split', 'delete_split']),
        budgetEntryId: z.number().int().positive(),
        splitId: optionalId,
        scheduleDate: optionalDate,
        scheduledAmount: z.number().nonnegative().optional(),
        dryRun: z.boolean().default(false),
        confirm: z.boolean().default(false),
      },
    },
    async (args, extra) => {
      const data = await portalRequest('/Api/v1/mcp/purchase-schedule/', {
        token: authToken(extra),
        method: 'POST',
        body: args,
      });
      return jsonToolResult(data);
    }
  );

  server.registerTool(
    'limu_list_payment_vouchers',
    {
      title: 'List payment vouchers',
      description: 'List payment vouchers with requisition, spend, item, proof, and payment-reference summary context.',
      inputSchema: {
        voucherId: optionalId,
        requisitionId: optionalId,
        status: z.enum(['submitted', 'approved', 'paid', 'declined']).optional(),
        paymentMethod: z.enum(['cash', 'bank_transfer', 'mobile_wallet']).optional(),
        initiatedFrom: optionalDate,
        initiatedTo: optionalDate,
        search: z.string().trim().min(1).max(160).optional(),
        limit: limitSchema,
        offset: offsetSchema,
      },
      annotations: { readOnlyHint: true },
    },
    async (args, extra) => {
      const data = await portalRequest('/Api/v1/mcp/payment-vouchers/', {
        token: authToken(extra),
        query: args,
      });
      return jsonToolResult(data);
    }
  );

  server.registerTool(
    'limu_mark_payment_voucher_paid',
    {
      title: 'Mark payment voucher paid',
      description: 'Mark a management-approved voucher as paid and post its allocated spend to the linked budget. Run with dryRun=true before confirming.',
      inputSchema: {
        voucherId: z.number().int().positive(),
        dryRun: z.boolean().default(true),
        confirm: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async (args, extra) => {
      const data = await portalRequest('/Api/v1/mcp/payment-vouchers/paid/', {
        token: authToken(extra),
        method: 'POST',
        body: args,
      });
      return jsonToolResult(data);
    }
  );

  server.registerTool(
    'limu_get_quickbooks_status',
    {
      title: 'QuickBooks connection status',
      description: 'Check whether the LIMU Portal QuickBooks connection is configured and active. QuickBooks credentials and tokens are never returned.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async (_args, extra) => jsonToolResult(await portalRequest('/Api/v1/mcp/quickbooks/', {
      token: authToken(extra),
      query: { action: 'status' },
    }))
  );

  server.registerTool(
    'limu_list_quickbooks_accounts',
    {
      title: 'List QuickBooks accounts',
      description: 'List active QuickBooks chart-of-accounts entries through the LIMU Portal connection.',
      inputSchema: { limit: z.number().int().min(1).max(200).default(100) },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }, extra) => jsonToolResult(await portalRequest('/Api/v1/mcp/quickbooks/', {
      token: authToken(extra),
      query: { action: 'accounts', limit },
    }))
  );

  server.registerTool(
    'limu_get_quickbooks_aged_receivables',
    {
      title: 'QuickBooks aged receivables',
      description: 'Read the QuickBooks aged receivables report, optionally as of a report date.',
      inputSchema: { reportDate: optionalDate },
      annotations: { readOnlyHint: true },
    },
    async ({ reportDate }, extra) => jsonToolResult(await portalRequest('/Api/v1/mcp/quickbooks/', {
      token: authToken(extra),
      query: { action: 'aged_receivables', reportDate },
    }))
  );

  server.registerTool(
    'limu_get_quickbooks_aged_payables',
    {
      title: 'QuickBooks aged payables',
      description: 'Read the QuickBooks aged payables report, optionally as of a report date.',
      inputSchema: { reportDate: optionalDate },
      annotations: { readOnlyHint: true },
    },
    async ({ reportDate }, extra) => jsonToolResult(await portalRequest('/Api/v1/mcp/quickbooks/', {
      token: authToken(extra),
      query: { action: 'aged_payables', reportDate },
    }))
  );

  server.registerTool(
    'limu_list_quickbooks_open_invoices',
    {
      title: 'List open QuickBooks invoices',
      description: 'List open QuickBooks invoices dated on or before the selected cut-off date.',
      inputSchema: { cutoffDate: optionalDate, limit: z.number().int().min(1).max(500).default(100) },
      annotations: { readOnlyHint: true },
    },
    async ({ cutoffDate, limit }, extra) => jsonToolResult(await portalRequest('/Api/v1/mcp/quickbooks/', {
      token: authToken(extra),
      query: { action: 'open_invoices', cutoffDate, limit },
    }))
  );

  server.registerTool(
    'limu_list_quickbooks_open_bills',
    {
      title: 'List open QuickBooks bills',
      description: 'List open QuickBooks bills dated on or before the selected cut-off date.',
      inputSchema: { cutoffDate: optionalDate, limit: z.number().int().min(1).max(500).default(100) },
      annotations: { readOnlyHint: true },
    },
    async ({ cutoffDate, limit }, extra) => jsonToolResult(await portalRequest('/Api/v1/mcp/quickbooks/', {
      token: authToken(extra),
      query: { action: 'open_bills', cutoffDate, limit },
    }))
  );

  server.registerTool(
    'limu_list_quickbooks_expenses',
    {
      title: 'List QuickBooks expenses',
      description: 'List QuickBooks Purchase and BillPayment transactions for a date range, optionally limited to a bank account. This is read-only and intended for bank reconciliation.',
      inputSchema: {
        startDate: optionalDate,
        endDate: optionalDate,
        bankAccountId: quickbooksId.optional(),
        limit: z.number().int().min(1).max(500).default(100),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ startDate, endDate, bankAccountId, limit }, extra) => jsonToolResult(await portalRequest('/Api/v1/mcp/quickbooks/', {
      token: authToken(extra),
      query: { action: 'expenses', startDate, endDate, bankAccountId, limit },
    }))
  );

  server.registerTool(
    'limu_create_quickbooks_invoice',
    {
      title: 'Create QuickBooks invoice',
      description: 'Preview or create a customer invoice through the LIMU Portal. Defaults to a dry run; set dryRun false and confirm true only after approval. Direct journals and deletions are not exposed.',
      inputSchema: {
        ...quickbooksPostingFields,
        customerId: quickbooksId,
        lines: z.array(quickbooksSalesLine).min(1).max(50),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args, extra) => jsonToolResult(await portalRequest('/Api/v1/mcp/quickbooks/', {
      token: authToken(extra), method: 'POST', body: { action: 'create_invoice', ...args },
    }))
  );

  server.registerTool(
    'limu_create_quickbooks_bill',
    {
      title: 'Create QuickBooks bill',
      description: 'Preview or create a supplier bill through the LIMU Portal. Defaults to a dry run; set dryRun false and confirm true only after approval.',
      inputSchema: {
        ...quickbooksPostingFields,
        vendorId: quickbooksId,
        lines: z.array(quickbooksExpenseLine).min(1).max(50),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args, extra) => jsonToolResult(await portalRequest('/Api/v1/mcp/quickbooks/', {
      token: authToken(extra), method: 'POST', body: { action: 'create_bill', ...args },
    }))
  );

  server.registerTool(
    'limu_create_quickbooks_payment',
    {
      title: 'Receive QuickBooks payment',
      description: 'Preview or record a customer payment against one or more invoices through the LIMU Portal. Defaults to a dry run; set dryRun false and confirm true only after approval.',
      inputSchema: {
        ...quickbooksPostingFields,
        customerId: quickbooksId,
        depositToAccountId: quickbooksId,
        totalAmount: quickbooksAmount,
        paymentReference: z.string().trim().max(100).optional(),
        applications: z.array(quickbooksApplication).min(1).max(50),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args, extra) => jsonToolResult(await portalRequest('/Api/v1/mcp/quickbooks/', {
      token: authToken(extra), method: 'POST', body: { action: 'create_payment', ...args },
    }))
  );

  server.registerTool(
    'limu_create_quickbooks_bill_payment',
    {
      title: 'Pay QuickBooks bills',
      description: 'Preview or record a bill payment against one or more supplier bills through the LIMU Portal. Defaults to a dry run; set dryRun false and confirm true only after approval.',
      inputSchema: {
        ...quickbooksPostingFields,
        vendorId: quickbooksId,
        bankAccountId: quickbooksId,
        paymentReference: z.string().trim().max(100).optional(),
        applications: z.array(quickbooksApplication).min(1).max(50),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args, extra) => jsonToolResult(await portalRequest('/Api/v1/mcp/quickbooks/', {
      token: authToken(extra), method: 'POST', body: { action: 'create_bill_payment', ...args },
    }))
  );

  const pendingTools = [
    ['limu_list_requisitions', '/Api/v1/mcp/requisitions/'],
    ['limu_get_requisition', '/Api/v1/mcp/requisitions/{id}'],
    ['limu_review_requisition', '/Api/v1/mcp/requisitions/{id}/review'],
    ['limu_delete_requisition', '/Api/v1/mcp/requisitions/{id}'],
    ['limu_get_payment_voucher', '/Api/v1/mcp/payment-vouchers/{id}'],
    ['limu_review_payment_voucher', '/Api/v1/mcp/payment-vouchers/{id}/review'],
    ['limu_delete_payment_voucher', '/Api/v1/mcp/payment-vouchers/{id}'],
    ['limu_list_leave_applications', '/Api/v1/mcp/leave-applications/'],
    ['limu_review_leave_application', '/Api/v1/mcp/leave-applications/{id}/review'],
  ];

  for (const [name, endpoint] of pendingTools) {
    server.registerTool(
      name,
      {
        title: name,
        description: `Pending portal API migration for ${endpoint}.`,
        inputSchema: {},
      },
      async () => notMigrated(name, endpoint)
    );
  }
}
