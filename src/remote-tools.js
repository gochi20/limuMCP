import { z } from 'zod';
import { jsonToolResult, portalRequest, tokenFromAuthInfo } from './portal-api.js';

const optionalText = z.string().trim().optional();
const optionalId = z.number().int().positive().optional();
const optionalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.').optional();
const optionalMonth = z.string().regex(/^\d{4}-\d{2}$/, 'Use YYYY-MM.').optional();
const limitSchema = z.number().int().min(1).max(100).default(25);
const offsetSchema = z.number().int().min(0).default(0);
const budgetFilters = {
  budgetEntryId: optionalId,
  budgetMonth: optionalMonth,
  categoryId: optionalId,
  category: optionalText,
  currency: optionalText,
  search: optionalText,
};

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

  const pendingTools = [
    ['limu_list_requisitions', '/Api/v1/mcp/requisitions/'],
    ['limu_get_requisition', '/Api/v1/mcp/requisitions/{id}'],
    ['limu_review_requisition', '/Api/v1/mcp/requisitions/{id}/review'],
    ['limu_delete_requisition', '/Api/v1/mcp/requisitions/{id}'],
    ['limu_list_payment_vouchers', '/Api/v1/mcp/payment-vouchers/'],
    ['limu_get_payment_voucher', '/Api/v1/mcp/payment-vouchers/{id}'],
    ['limu_review_payment_voucher', '/Api/v1/mcp/payment-vouchers/{id}/review'],
    ['limu_delete_payment_voucher', '/Api/v1/mcp/payment-vouchers/{id}'],
    ['limu_mark_payment_voucher_paid', '/Api/v1/mcp/payment-vouchers/{id}/paid'],
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
