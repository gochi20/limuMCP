import { z } from 'zod';
import { jsonToolResult, portalRequest, tokenFromAuthInfo } from './portal-api.js';

const optionalText = z.string().trim().optional();
const optionalId = z.number().int().positive().optional();
const limitSchema = z.number().int().min(1).max(100).default(25);
const offsetSchema = z.number().int().min(0).default(0);

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

  const pendingTools = [
    ['limu_list_monthly_budgets', '/Api/v1/mcp/monthly-budgets/'],
    ['limu_get_monthly_budget', '/Api/v1/mcp/monthly-budgets/{id}'],
    ['limu_list_purchase_schedule', '/Api/v1/mcp/purchase-schedule/'],
    ['limu_schedule_budget_purchase', '/Api/v1/mcp/purchase-schedule/'],
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
