#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const SERVER_VERSION = '0.1.0';
const DEFAULT_LIMIT = clampInt(process.env.LIMU_MCP_DEFAULT_LIMIT, 25, 1, 100);
const MAX_LIMIT = clampInt(process.env.LIMU_MCP_MAX_LIMIT, 100, 1, 500);

const pool = mysql.createPool({
  host: process.env.LIMU_DB_HOST || '127.0.0.1',
  port: clampInt(process.env.LIMU_DB_PORT, 3306, 1, 65535),
  socketPath: process.env.LIMU_DB_SOCKET || undefined,
  user: process.env.LIMU_DB_USER || 'root',
  password: process.env.LIMU_DB_PASSWORD || '',
  database: process.env.LIMU_DB_NAME || 'limutradee',
  waitForConnections: true,
  connectionLimit: clampInt(process.env.LIMU_DB_CONNECTION_LIMIT, 5, 1, 20),
  decimalNumbers: true,
  dateStrings: true,
  charset: 'utf8mb4',
  multipleStatements: false,
});

const tableCache = new Map();
const columnsCache = new Map();
const resolvedTableCache = new Map();

const limitSchema = z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT);
const offsetSchema = z.coerce.number().int().min(0).default(0);
const idSchema = z.coerce.number().int().positive();
const optionalIdSchema = z.coerce.number().int().positive().optional();
const optionalTextSchema = z.string().trim().min(1).optional();
const optionalDateSchema = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional();
const optionalMonthSchema = z.string().trim().regex(/^\d{4}-\d{2}$/).optional();
const reportGroupSchema = z.enum(['daily', 'weekly', 'monthly']).optional();
const actorIdSchema = z.coerce.number().int().positive();
const optionalReasonSchema = z.string().trim().max(160).optional();
const optionalClientTextSchema = z.string().trim().max(500).optional();
const optionalClientLongTextSchema = z.string().trim().max(2000).optional();
const moneySchema = z.coerce.number().positive();
const relationEmployeeIdSchema = z.preprocess(
  (value) => value === null || value === '' ? 0 : value,
  z.coerce.number().int().min(0)
).optional();

const server = new McpServer(
  {
    name: 'limu-portal-mcp',
    version: SERVER_VERSION,
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

server.registerResource(
  'limu_portal_mcp_catalog',
  'limu://portal/catalog',
  {
    title: 'LIMU Portal MCP Catalog',
    description: 'Catalog of exposed LIMU Portal operational, HR, and finance datasets plus controlled approval actions.',
    mimeType: 'application/json',
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(
          {
            server: 'limu-portal-mcp',
            version: SERVER_VERSION,
            mode: 'read-mostly; controlled tools can update clients, purchase schedules, leave approvals, requisitions, and payment vouchers',
            entities: [
              'clients',
              'cargo',
              'cargo_packages',
              'shipments',
              'client_profile_reports',
              'lead_reports',
              'order_form_reports',
              'import_product_reports',
              'timesheet_reports',
              'monthly_budget_entry',
              'monthly_budget_entry_schedule_split',
              'shipment_budget',
              'shipment_budget_income',
              'shipment_budget_item',
              'shipment_budget_log',
              'shipping_shipment_budget',
              'shipping_shipment_budget_income',
              'shipping_shipment_budget_item',
              'shipping_shipment_budget_log',
              'requisitions',
              'payment_vouchers',
              'requisition_approvals',
              'payment_voucher_reviews',
              'client_kyc_links',
              'client_kyc_submissions',
              'leave_applications',
              'leave_application_logs',
              'leave_assignments',
              'leave_types',
            ],
          },
          null,
          2
        ),
      },
    ],
  })
);

registerTool(
  'limu_health',
  {
    title: 'LIMU MCP health',
    description: 'Check database connectivity and report which LIMU Portal tables are visible.',
    inputSchema: {},
  },
  async () => {
    const [dbRows] = await pool.query('SELECT DATABASE() AS databaseName, NOW() AS serverTime');
    const tables = [
      'cargo',
      'cargo_packages',
      'cargo_package_units',
      'shipment',
      'shipmentcalendar',
      'monthly_budget_entry',
      'shipment_budget',
      'shipment_budget_income',
      'shipment_budget_item',
      'shipment_budget_log',
      'shipping_shipment_budget',
      'shipping_shipment_budget_income',
      'shipping_shipment_budget_item',
      'shipping_shipment_budget_log',
      'requisitions',
      'requisition_items',
      'payment_vouchers',
      'payment_voucher_items',
      'client_kyc_links',
      'client_kyc_submissions',
      'client_queries',
      'api_v4_client_credentials',
      'api_v4_client_sessions',
      'api_v4_client_device_tokens',
      'Clients',
      'client_leads',
      'client_lead_portfolios',
      'order_forms',
      'order_form_items',
      'order_form_status_logs',
      'timesheet_entries',
      'timesheet_policies',
      'warehouse_work_timesheets',
      'leave_applications',
      'leave_application_logs',
      'leave_assignments',
      'leave_types',
      'early_late_requests',
    ];
    const visibility = {};
    for (const table of tables) {
      visibility[table] = await tableExists(table);
    }

    return {
      database: dbRows[0] || null,
      visibleTables: visibility,
      defaultLimit: DEFAULT_LIMIT,
      maxLimit: MAX_LIMIT,
    };
  }
);

registerTool(
  'limu_get_clients',
  {
    title: 'Get clients',
    description: 'List/search LIMU clients with associated cargo, shipment, package, invoice, payment, order, lead, KYC, and mobile-account summary data.',
    inputSchema: {
      clientId: optionalIdSchema,
      name: optionalTextSchema,
      email: optionalTextSchema,
      phone: optionalTextSchema,
      gender: optionalTextSchema,
      business: optionalTextSchema,
      businessCategory: optionalTextSchema,
      location: optionalTextSchema,
      category: optionalTextSchema,
      tier: optionalTextSchema,
      createdFrom: optionalDateSchema,
      createdTo: optionalDateSchema,
      activeFrom: optionalDateSchema,
      activeTo: optionalDateSchema,
      onlyWithActivity: z.boolean().default(false),
      search: optionalTextSchema,
      limit: limitSchema,
      offset: offsetSchema,
    },
  },
  listClients
);

registerTool(
  'limu_get_client',
  {
    title: 'Get client',
    description: 'Get one LIMU client with recent associated cargo, shipments, packages, invoices, payments, order forms, leads, KYC, queries, and mobile access summaries.',
    inputSchema: {
      clientId: idSchema,
      includeCargo: z.boolean().default(true),
      includeShipments: z.boolean().default(true),
      includePackages: z.boolean().default(true),
      includeInvoices: z.boolean().default(true),
      includePayments: z.boolean().default(true),
      includeOrderForms: z.boolean().default(true),
      includeLeads: z.boolean().default(true),
      includeKyc: z.boolean().default(true),
      includeQueries: z.boolean().default(true),
      includeMobileAccess: z.boolean().default(true),
      limit: limitSchema,
    },
  },
  getClient
);

registerTool(
  'limu_update_client',
  {
    title: 'Update client',
    description: 'Update editable LIMU client profile fields in the Clients table. Requires confirm=true for real writes; use dryRun=true to preview changes.',
    inputSchema: {
      clientId: idSchema,
      actorId: actorIdSchema,
      firstName: z.string().trim().min(1).max(120).optional(),
      lastName: z.string().trim().min(1).max(120).optional(),
      email: z.string().trim().max(190).optional(),
      clearEmail: z.boolean().default(false),
      phone: z.string().trim().min(1).max(80).optional(),
      gender: z.string().trim().max(20).optional(),
      business: optionalClientTextSchema,
      businessCategory: optionalClientTextSchema,
      location: optionalClientTextSchema,
      clientType: z.enum(['Business', 'Personal']).optional(),
      category: z.string().trim().min(1).max(80).optional(),
      dob: z.string().trim().max(40).optional(),
      photoUrl: z.string().trim().max(500).optional(),
      relationEmployeeId: relationEmployeeIdSchema,
      alternatePhones: optionalClientLongTextSchema,
      occupations: optionalClientLongTextSchema,
      interests: optionalClientLongTextSchema,
      businessSize: optionalClientTextSchema,
      businessOffering: optionalClientTextSchema,
      goodsCategories: optionalClientLongTextSchema,
      serviceCategories: optionalClientLongTextSchema,
      includeAssociatedData: z.boolean().default(false),
      dryRun: z.boolean().default(false),
      confirm: z.boolean().default(false),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  updateClient
);

registerTool(
  'limu_list_cargo',
  {
    title: 'List cargo',
    description: 'Search LIMU cargo records with client, shipment, and package summary context.',
    inputSchema: {
      cargoId: optionalIdSchema,
      shipmentId: optionalIdSchema,
      clientId: optionalIdSchema,
      trackingNumber: optionalTextSchema,
      packageCode: optionalTextSchema,
      status: optionalTextSchema,
      financeStatus: optionalTextSchema,
      location: optionalTextSchema,
      search: optionalTextSchema,
      createdFrom: optionalDateSchema,
      createdTo: optionalDateSchema,
      limit: limitSchema,
      offset: offsetSchema,
    },
  },
  listCargo
);

registerTool(
  'limu_get_cargo',
  {
    title: 'Get cargo',
    description: 'Get one cargo record with packages, collection details, and recent cargo log events.',
    inputSchema: {
      cargoId: idSchema,
      includeLogs: z.boolean().default(true),
      packageLimit: limitSchema,
      logLimit: limitSchema,
    },
  },
  getCargo
);

registerTool(
  'limu_list_packages',
  {
    title: 'List packages',
    description: 'Search cargo package groups and their unit check progress.',
    inputSchema: {
      packageId: optionalIdSchema,
      cargoId: optionalIdSchema,
      shipmentId: optionalIdSchema,
      packageCode: optionalTextSchema,
      courierTrackingNumber: optionalTextSchema,
      content: optionalTextSchema,
      checked: z.boolean().optional(),
      search: optionalTextSchema,
      limit: limitSchema,
      offset: offsetSchema,
    },
  },
  listPackages
);

registerTool(
  'limu_get_package',
  {
    title: 'Get package',
    description: 'Get a cargo package by id or code, including units and stage checks.',
    inputSchema: {
      packageId: optionalIdSchema,
      packageCode: optionalTextSchema,
      includeUnits: z.boolean().default(true),
      unitLimit: limitSchema,
    },
  },
  getPackage
);

registerTool(
  'limu_list_shipments',
  {
    title: 'List shipments',
    description: 'Search shipments with calendar, cargo, and package totals.',
    inputSchema: {
      shipmentId: optionalIdSchema,
      status: optionalTextSchema,
      mode: optionalTextSchema,
      location: optionalTextSchema,
      search: optionalTextSchema,
      departureFrom: optionalDateSchema,
      departureTo: optionalDateSchema,
      arrivalFrom: optionalDateSchema,
      arrivalTo: optionalDateSchema,
      limit: limitSchema,
      offset: offsetSchema,
    },
  },
  listShipments
);

registerTool(
  'limu_get_shipment',
  {
    title: 'Get shipment',
    description: 'Get one shipment with cargo summary, calendar entries, budget summary, and recent updates.',
    inputSchema: {
      shipmentId: idSchema,
      includeCargo: z.boolean().default(true),
      includeLogs: z.boolean().default(true),
      cargoLimit: limitSchema,
      logLimit: limitSchema,
    },
  },
  getShipment
);

registerTool(
  'limu_list_monthly_budgets',
  {
    title: 'List monthly budgets',
    description: 'List monthly budget entries with categories, spend, balance, and schedule summaries.',
    inputSchema: {
      budgetEntryId: optionalIdSchema,
      budgetMonth: optionalMonthSchema,
      categoryId: optionalIdSchema,
      category: optionalTextSchema,
      currency: optionalTextSchema,
      search: optionalTextSchema,
      limit: limitSchema,
      offset: offsetSchema,
    },
  },
  listMonthlyBudgets
);

registerTool(
  'limu_get_monthly_budget',
  {
    title: 'Get monthly budget',
    description: 'Get a monthly budget period summary or one budget entry with schedule splits and linked requisition/payment voucher usage.',
    inputSchema: {
      budgetEntryId: optionalIdSchema,
      budgetMonth: optionalMonthSchema,
      categoryId: optionalIdSchema,
      category: optionalTextSchema,
      currency: optionalTextSchema,
      search: optionalTextSchema,
      includeScheduleSplits: z.boolean().default(true),
      includeUsage: z.boolean().default(true),
      linkedLimit: limitSchema,
      limit: limitSchema,
      offset: offsetSchema,
    },
  },
  getMonthlyBudget
);

registerTool(
  'limu_list_purchase_schedule',
  {
    title: 'List purchase schedule',
    description: 'List scheduled budget purchases from monthly budget entries and split schedules.',
    inputSchema: {
      budgetEntryId: optionalIdSchema,
      scheduledFrom: optionalDateSchema,
      scheduledTo: optionalDateSchema,
      budgetMonth: optionalMonthSchema,
      categoryId: optionalIdSchema,
      category: optionalTextSchema,
      search: optionalTextSchema,
      limit: limitSchema,
      offset: offsetSchema,
    },
  },
  listPurchaseSchedule
);

registerTool(
  'limu_schedule_budget_purchase',
  {
    title: 'Schedule budget purchase',
    description: 'Set or clear a monthly budget purchase date, or add/update/delete split purchase schedule rows. Requires confirm=true for real writes; use dryRun=true first.',
    inputSchema: {
      action: z.enum(['set_single_date', 'clear_single_date', 'add_split', 'update_split', 'delete_split']),
      budgetEntryId: idSchema,
      splitId: optionalIdSchema,
      scheduleDate: optionalDateSchema,
      scheduledAmount: moneySchema.optional(),
      actorId: actorIdSchema,
      dryRun: z.boolean().default(false),
      confirm: z.boolean().default(false),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
  },
  scheduleBudgetPurchase
);

registerTool(
  'limu_list_shipment_budgets',
  {
    title: 'List shipment budgets',
    description: 'List customs and shipping shipment budgets with income, expense, spend, and balance totals.',
    inputSchema: {
      budgetType: z.enum(['all', 'customs', 'shipping']).default('all'),
      budgetId: optionalIdSchema,
      shipmentId: optionalIdSchema,
      search: optionalTextSchema,
      limit: limitSchema,
      offset: offsetSchema,
    },
  },
  listShipmentBudgets
);

registerTool(
  'limu_get_shipment_budget',
  {
    title: 'Get shipment budget',
    description: 'Get one customs or shipping shipment budget with income rows, expense rows, totals, and logs when present.',
    inputSchema: {
      budgetType: z.enum(['customs', 'shipping']).default('customs'),
      budgetId: optionalIdSchema,
      shipmentId: optionalIdSchema,
      includeLogs: z.boolean().default(true),
      logLimit: limitSchema,
    },
  },
  getShipmentBudget
);

registerTool(
  'limu_list_customs_budgets',
  {
    title: 'List customs budgets',
    description: 'List read-only customs shipment budgets with income, expense, spend, and balance totals.',
    inputSchema: {
      budgetId: optionalIdSchema,
      shipmentId: optionalIdSchema,
      search: optionalTextSchema,
      limit: limitSchema,
      offset: offsetSchema,
    },
  },
  listCustomsBudgets
);

registerTool(
  'limu_get_customs_budget',
  {
    title: 'Get customs budget',
    description: 'Get one read-only customs shipment budget with income rows, expense rows, totals, and logs when present.',
    inputSchema: {
      budgetId: optionalIdSchema,
      shipmentId: optionalIdSchema,
      includeLogs: z.boolean().default(true),
      logLimit: limitSchema,
    },
  },
  getCustomsBudget
);

registerTool(
  'limu_list_shipping_budgets',
  {
    title: 'List shipping budgets',
    description: 'List read-only shipping/shipment budgets with income, expense, spend, and balance totals.',
    inputSchema: {
      budgetId: optionalIdSchema,
      shipmentId: optionalIdSchema,
      search: optionalTextSchema,
      limit: limitSchema,
      offset: offsetSchema,
    },
  },
  listShippingBudgets
);

registerTool(
  'limu_get_shipping_budget',
  {
    title: 'Get shipping budget',
    description: 'Get one read-only shipping/shipment budget with income rows, expense rows, totals, and logs when present.',
    inputSchema: {
      budgetId: optionalIdSchema,
      shipmentId: optionalIdSchema,
      includeLogs: z.boolean().default(true),
      logLimit: limitSchema,
    },
  },
  getShippingBudget
);

registerTool(
  'limu_list_requisitions',
  {
    title: 'List requisitions',
    description: 'List finance requisitions with approval stage, items, and voucher spend totals.',
    inputSchema: {
      requisitionId: optionalIdSchema,
      status: optionalTextSchema,
      stage: optionalTextSchema,
      approvedOnly: z.boolean().default(false),
      requestedFrom: optionalDateSchema,
      requestedTo: optionalDateSchema,
      search: optionalTextSchema,
      limit: limitSchema,
      offset: offsetSchema,
    },
  },
  listRequisitions
);

registerTool(
  'limu_get_requisition',
  {
    title: 'Get requisition',
    description: 'Get one requisition with items, logs, and linked payment vouchers.',
    inputSchema: {
      requisitionId: idSchema,
      includeLogs: z.boolean().default(true),
      logLimit: limitSchema,
    },
  },
  getRequisition
);

registerTool(
  'limu_review_requisition',
  {
    title: 'Review requisition',
    description: 'Approve or decline a requisition approval stage using the same admin, finance, and management sequencing as the portal.',
    inputSchema: {
      requisitionId: idSchema,
      stage: z.enum(['admin', 'finance', 'management']),
      decision: z.enum(['approve', 'decline']),
      actorId: actorIdSchema,
      reason: optionalReasonSchema,
      dryRun: z.boolean().default(false),
      confirm: z.boolean().default(false),
    },
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
  },
  reviewRequisition
);

registerTool(
  'limu_delete_requisition',
  {
    title: 'Delete requisition',
    description: 'Delete a requisition and its requisition items/logs when it has no linked payment vouchers. Requires confirm=true for real deletes; use dryRun=true first.',
    inputSchema: {
      requisitionId: idSchema,
      actorId: actorIdSchema,
      reason: optionalReasonSchema,
      dryRun: z.boolean().default(false),
      confirm: z.boolean().default(false),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
  },
  deleteRequisition
);

registerTool(
  'limu_list_payment_vouchers',
  {
    title: 'List payment vouchers',
    description: 'List payment vouchers with requisition, spend, item, and proof summary context.',
    inputSchema: {
      voucherId: optionalIdSchema,
      requisitionId: optionalIdSchema,
      status: optionalTextSchema,
      paymentMethod: optionalTextSchema,
      initiatedFrom: optionalDateSchema,
      initiatedTo: optionalDateSchema,
      search: optionalTextSchema,
      limit: limitSchema,
      offset: offsetSchema,
    },
  },
  listPaymentVouchers
);

registerTool(
  'limu_get_payment_voucher',
  {
    title: 'Get payment voucher',
    description: 'Get one payment voucher with items, proofs, and linked requisition details.',
    inputSchema: {
      voucherId: idSchema,
    },
  },
  getPaymentVoucher
);

registerTool(
  'limu_review_payment_voucher',
  {
    title: 'Review payment voucher',
    description: 'Approve or decline a submitted payment voucher. Approval moves the voucher to management-approved; finance still marks it paid separately.',
    inputSchema: {
      voucherId: idSchema,
      decision: z.enum(['approve', 'decline']),
      actorId: actorIdSchema,
      reason: optionalReasonSchema,
      dryRun: z.boolean().default(false),
      confirm: z.boolean().default(false),
    },
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
  },
  reviewPaymentVoucher
);

registerTool(
  'limu_delete_payment_voucher',
  {
    title: 'Delete payment voucher',
    description: 'Delete a submitted or declined payment voucher and its items/proof rows. Requires confirm=true for real deletes; use dryRun=true first.',
    inputSchema: {
      voucherId: idSchema,
      actorId: actorIdSchema,
      reason: optionalReasonSchema,
      dryRun: z.boolean().default(false),
      confirm: z.boolean().default(false),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
  },
  deletePaymentVoucher
);

registerTool(
  'limu_mark_payment_voucher_paid',
  {
    title: 'Mark payment voucher paid',
    description: 'Mark a management-approved payment voucher as paid, post voucher spend to monthly/shipment budget items, and refresh the requisition status.',
    inputSchema: {
      voucherId: idSchema,
      actorId: actorIdSchema,
      dryRun: z.boolean().default(false),
      confirm: z.boolean().default(false),
    },
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
  },
  markPaymentVoucherPaid
);

registerTool(
  'limu_list_client_profile_reports',
  {
    title: 'List client profile reports',
    description: 'Report on client profiles with cargo activity, lead counts, and order-form totals.',
    inputSchema: {
      clientId: optionalIdSchema,
      clientType: optionalTextSchema,
      gender: optionalTextSchema,
      tier: optionalTextSchema,
      relationEmployeeId: optionalIdSchema,
      createdFrom: optionalDateSchema,
      createdTo: optionalDateSchema,
      activeFrom: optionalDateSchema,
      activeTo: optionalDateSchema,
      onlyWithCargoActivity: z.boolean().default(false),
      search: optionalTextSchema,
      limit: limitSchema,
      offset: offsetSchema,
    },
  },
  listClientProfileReports
);

registerTool(
  'limu_get_client_profile_report',
  {
    title: 'Get client profile report',
    description: 'Get one client profile with recent cargo, lead, and order-form report context.',
    inputSchema: {
      clientId: idSchema,
      includeCargo: z.boolean().default(true),
      includeLeads: z.boolean().default(true),
      includeOrders: z.boolean().default(true),
      limit: limitSchema,
    },
  },
  getClientProfileReport
);

registerTool(
  'limu_list_lead_reports',
  {
    title: 'List lead reports',
    description: 'Report on client leads with status, permission, district, owner, and volume summaries.',
    inputSchema: {
      leadId: optionalIdSchema,
      status: optionalTextSchema,
      permissionStatus: optionalTextSchema,
      district: optionalTextSchema,
      ownerId: optionalIdSchema,
      procurementEmployeeId: optionalIdSchema,
      portfolioId: optionalIdSchema,
      createdBy: optionalIdSchema,
      createdFrom: optionalDateSchema,
      createdTo: optionalDateSchema,
      groupBy: reportGroupSchema,
      search: optionalTextSchema,
      includeSummary: z.boolean().default(true),
      limit: limitSchema,
      offset: offsetSchema,
    },
  },
  listLeadReports
);

registerTool(
  'limu_get_lead_report',
  {
    title: 'Get lead report',
    description: 'Get one lead with assigned employees and portfolio context.',
    inputSchema: {
      leadId: idSchema,
    },
  },
  getLeadReport
);

registerTool(
  'limu_list_order_form_reports',
  {
    title: 'List order form reports',
    description: 'Report on order forms with status, assignee, client, shipment, value, and volume summaries.',
    inputSchema: {
      orderId: optionalIdSchema,
      clientId: optionalIdSchema,
      shipmentId: optionalIdSchema,
      status: optionalTextSchema,
      assignedTo: optionalTextSchema,
      preparedBy: optionalTextSchema,
      orderType: optionalTextSchema,
      createdFrom: optionalDateSchema,
      createdTo: optionalDateSchema,
      groupBy: reportGroupSchema,
      search: optionalTextSchema,
      includeSummary: z.boolean().default(true),
      limit: limitSchema,
      offset: offsetSchema,
    },
  },
  listOrderFormReports
);

registerTool(
  'limu_get_order_form_report',
  {
    title: 'Get order form report',
    description: 'Get one order form with line items, status timeline, and purchase proofs.',
    inputSchema: {
      orderId: optionalIdSchema,
      orderNumber: optionalTextSchema,
    },
  },
  getOrderFormReport
);

registerTool(
  'limu_get_import_product_report',
  {
    title: 'Get import product report',
    description: 'Read the Import Product Report with imported cargo categories, top importers, client-category rows, and import trend data.',
    inputSchema: {
      from: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
      to: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
      productCategory: optionalTextSchema,
      categoryLimit: z.coerce.number().int().min(1).max(100).default(20),
      clientLimit: z.coerce.number().int().min(1).max(500).default(100),
      topImporterLimit: z.coerce.number().int().min(1).max(50).default(10),
    },
  },
  getImportProductReport
);

registerTool(
  'limu_list_leave_applications',
  {
    title: 'List leave applications',
    description: 'List leave applications with employee, leave type, balance, approval stage, and optional approval logs.',
    inputSchema: {
      applicationId: optionalIdSchema,
      employeeId: optionalIdSchema,
      leaveTypeId: optionalIdSchema,
      status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
      stage: z.enum(['admin', 'management', 'completed', 'rejected', 'cancelled']).optional(),
      startFrom: optionalDateSchema,
      startTo: optionalDateSchema,
      endFrom: optionalDateSchema,
      endTo: optionalDateSchema,
      submittedFrom: optionalDateSchema,
      submittedTo: optionalDateSchema,
      search: optionalTextSchema,
      includeLogs: z.boolean().default(false),
      includeSummary: z.boolean().default(true),
      limit: limitSchema,
      offset: offsetSchema,
    },
  },
  listLeaveApplications
);

registerTool(
  'limu_review_leave_application',
  {
    title: 'Review leave application',
    description: 'Approve or decline a leave application at the admin or management stage. Requires confirm=true for real writes; use dryRun=true to preview.',
    inputSchema: {
      applicationId: idSchema,
      stage: z.enum(['admin', 'management']),
      decision: z.enum(['approve', 'decline']),
      actorId: actorIdSchema,
      note: z.string().trim().max(800).optional(),
      dryRun: z.boolean().default(false),
      confirm: z.boolean().default(false),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  reviewLeaveApplication
);

registerTool(
  'limu_list_timesheet_reports',
  {
    title: 'List timesheet reports',
    description: 'Report on employee clock-in/clock-out timesheets with hours, lateness, exceptions, leave, and early/late request summaries.',
    inputSchema: {
      employeeId: optionalIdSchema,
      startDate: optionalDateSchema,
      endDate: optionalDateSchema,
      status: optionalTextSchema,
      search: optionalTextSchema,
      includeSummary: z.boolean().default(true),
      limit: limitSchema,
      offset: offsetSchema,
    },
  },
  listTimesheetReports
);

registerTool(
  'limu_list_warehouse_timesheet_reports',
  {
    title: 'List warehouse timesheet reports',
    description: 'Report on warehouse work timesheets with schedule, shipment, payment, and employee context.',
    inputSchema: {
      employeeId: optionalIdSchema,
      shipmentId: optionalIdSchema,
      workType: optionalTextSchema,
      paymentStatus: optionalTextSchema,
      startDate: optionalDateSchema,
      endDate: optionalDateSchema,
      search: optionalTextSchema,
      includeSummary: z.boolean().default(true),
      limit: limitSchema,
      offset: offsetSchema,
    },
  },
  listWarehouseTimesheetReports
);

async function listClients(args) {
  const info = await resolveClientsInfo(true);
  const c = info.columns;
  const hasEmployee = Boolean(c.relationEmployeeId) && await tableExists('employee');
  const hasCargo = await tableExists('cargo');
  const hasPackages = hasCargo && await tableExists('cargo_packages');
  const hasInvoice = await tableExists('invoice');
  const hasPayment = await tableExists('payment');
  const orderInfo = await resolveOrderFormInfo(false);
  const hasLeads = await tableExists('client_leads');
  const hasKycLinks = await tableExists('client_kyc_links');
  const hasKycSubmissions = await tableExists('client_kyc_submissions');
  const hasCredentials = await tableExists('api_v4_client_credentials');
  const hasSessions = await tableExists('api_v4_client_sessions');
  const hasDevices = await tableExists('api_v4_client_device_tokens');
  const deviceActivityColumn = hasDevices
    ? await pickColumn('api_v4_client_device_tokens', ['updated_at', 'last_seen_at', 'created_at'])
    : null;
  const hasQueries = await tableExists('client_queries');

  const joins = [];
  const joinParams = [];

  if (hasEmployee) {
    joins.push(`LEFT JOIN employee rel ON rel.employeeid = cl.${qid(c.relationEmployeeId)}`);
  }

  if (hasCargo) {
    const activity = clientCargoActivityFilter('cg', args);
    joins.push(
      `LEFT JOIN (
        SELECT cg.\`userid\` AS clientId,
               COUNT(*) AS cargoCount,
               COUNT(DISTINCT CASE WHEN COALESCE(cg.\`shipmentid\`, 0) > 0 THEN cg.\`shipmentid\` END) AS shipmentCount,
               COALESCE(SUM(cg.\`packages\`), 0) AS declaredPackages,
               COALESCE(SUM(cg.\`weight\`), 0) AS totalWeight,
               COALESCE(SUM(cg.\`volume\`), 0) AS totalVolume,
               COALESCE(SUM(CASE WHEN LOWER(COALESCE(cg.\`cargostatus\`, '')) LIKE '%collect%' THEN 1 ELSE 0 END), 0) AS collectedCargoCount,
               COALESCE(SUM(CASE WHEN LOWER(COALESCE(cg.\`financestatus\`, '')) LIKE '%paid%' AND LOWER(COALESCE(cg.\`financestatus\`, '')) NOT LIKE '%not%' THEN 1 ELSE 0 END), 0) AS paidCargoCount,
               MIN(cg.\`cargocreatedon\`) AS firstCargoAt,
               MAX(cg.\`cargocreatedon\`) AS lastCargoAt
        FROM cargo cg
        ${whereSql(activity.where)}
        GROUP BY cg.\`userid\`
      ) cargo ON cargo.clientId = cl.${qid(c.id)}`
    );
    joinParams.push(...activity.params);
  }

  if (hasPackages) {
    const activity = clientCargoActivityFilter('cg_pkg', args);
    joins.push(
      `LEFT JOIN (
        SELECT cg_pkg.\`userid\` AS clientId,
               COUNT(cp.\`id\`) AS packageGroupCount,
               COALESCE(SUM(cp.\`quantity\`), 0) AS packageUnitCount,
               COALESCE(SUM(CASE WHEN cp.\`checked_at\` IS NOT NULL THEN cp.\`quantity\` ELSE 0 END), 0) AS checkedPackageUnitCount,
               MAX(cp.\`created_at\`) AS latestPackageAt
        FROM cargo_packages cp
        INNER JOIN cargo cg_pkg ON cg_pkg.\`cargoid\` = cp.\`cargo_id\`
        ${whereSql(activity.where)}
        GROUP BY cg_pkg.\`userid\`
      ) packages ON packages.clientId = cl.${qid(c.id)}`
    );
    joinParams.push(...activity.params);
  }

  if (hasInvoice) {
    joins.push(
      `LEFT JOIN (
        SELECT i.\`clientid\` AS clientId,
               COUNT(*) AS invoiceCount,
               COALESCE(SUM(${numericExpression('i.`invoicetotal`')}), 0) AS invoiceTotal,
               COALESCE(SUM(${numericExpression('i.`invoicebalance`')}), 0) AS invoiceBalance,
               COALESCE(SUM(CASE WHEN LOWER(TRIM(COALESCE(i.\`invoicestatus\`, ''))) = 'paid' THEN 1 ELSE 0 END), 0) AS paidInvoiceCount,
               COALESCE(SUM(CASE WHEN LOWER(TRIM(COALESCE(i.\`invoicestatus\`, ''))) <> 'paid' THEN 1 ELSE 0 END), 0) AS unpaidInvoiceCount,
               MAX(i.\`invoicedate\`) AS latestInvoiceAt
        FROM invoice i
        GROUP BY i.\`clientid\`
      ) invoices ON invoices.clientId = cl.${qid(c.id)}`
    );
  }

  if (hasPayment) {
    joins.push(
      `LEFT JOIN (
        SELECT p.\`clientid\` AS clientId,
               COUNT(*) AS paymentCount,
               COALESCE(SUM(p.\`paymentamount\`), 0) AS paymentTotal,
               COALESCE(SUM(CASE WHEN LOWER(COALESCE(p.\`paymentstatus\`, '')) LIKE '%approved%' THEN p.\`paymentamount\` ELSE 0 END), 0) AS approvedPaymentTotal,
               COALESCE(SUM(CASE WHEN LOWER(COALESCE(p.\`paymentstatus\`, '')) NOT LIKE '%approved%' THEN p.\`paymentamount\` ELSE 0 END), 0) AS pendingPaymentTotal,
               MAX(p.\`paymentdate\`) AS latestPaymentAt
        FROM payment p
        GROUP BY p.\`clientid\`
      ) payments ON payments.clientId = cl.${qid(c.id)}`
    );
  }

  if (orderInfo?.table && orderInfo.columns.clientId) {
    const oc = orderInfo.columns;
    joins.push(
      `LEFT JOIN (
        SELECT o.${qid(oc.clientId)} AS clientId,
               COUNT(*) AS orderFormCount,
               COALESCE(SUM(${oc.total ? `o.${qid(oc.total)}` : '0'}), 0) AS orderFormValue,
               MAX(${oc.created ? `o.${qid(oc.created)}` : `o.${qid(oc.id)}`}) AS latestOrderFormAt
        FROM ${qid(orderInfo.table)} o
        GROUP BY o.${qid(oc.clientId)}
      ) orders ON orders.clientId = cl.${qid(c.id)}`
    );
  }

  if (hasLeads) {
    joins.push(
      `LEFT JOIN (
        SELECT LOWER(TRIM(lead_phone)) AS leadKey,
               COUNT(*) AS leadCount,
               COALESCE(SUM(CASE WHEN LOWER(COALESCE(lead_status, '')) LIKE '%convert%' THEN 1 ELSE 0 END), 0) AS convertedLeadCount,
               MAX(created_on) AS latestLeadAt
        FROM client_leads
        WHERE TRIM(COALESCE(lead_phone, '')) <> ''
        GROUP BY LOWER(TRIM(lead_phone))
      ) leads_phone ON ${c.phone ? `leads_phone.leadKey = LOWER(TRIM(cl.${qid(c.phone)}))` : '1 = 0'}`
    );
    joins.push(
      `LEFT JOIN (
        SELECT LOWER(TRIM(lead_email)) AS leadKey,
               COUNT(*) AS leadCount,
               COALESCE(SUM(CASE WHEN LOWER(COALESCE(lead_status, '')) LIKE '%convert%' THEN 1 ELSE 0 END), 0) AS convertedLeadCount,
               MAX(created_on) AS latestLeadAt
        FROM client_leads
        WHERE TRIM(COALESCE(lead_email, '')) <> ''
        GROUP BY LOWER(TRIM(lead_email))
      ) leads_email ON ${c.email ? `leads_email.leadKey = LOWER(TRIM(cl.${qid(c.email)}))` : '1 = 0'}`
    );
  }

  if (hasKycLinks) {
    joins.push(
      `LEFT JOIN (
        SELECT client_id AS clientId,
               COUNT(*) AS kycLinkCount,
               COALESCE(SUM(CASE WHEN completed_at IS NOT NULL OR LOWER(COALESCE(status, '')) IN ('complete', 'completed', 'approved') THEN 1 ELSE 0 END), 0) AS completedKycLinkCount,
               MAX(created_at) AS latestKycLinkAt,
               MAX(completed_at) AS latestKycCompletedAt
        FROM client_kyc_links
        WHERE client_id IS NOT NULL
        GROUP BY client_id
      ) kyc_links ON kyc_links.clientId = cl.${qid(c.id)}`
    );
  }

  if (hasKycSubmissions) {
    joins.push(
      `LEFT JOIN (
        SELECT client_id AS clientId,
               COUNT(*) AS kycSubmissionCount,
               MAX(created_at) AS latestKycSubmissionAt,
               MAX(updated_at) AS latestKycUpdatedAt
        FROM client_kyc_submissions
        WHERE client_id IS NOT NULL
        GROUP BY client_id
      ) kyc_submissions ON kyc_submissions.clientId = cl.${qid(c.id)}`
    );
  }

  if (hasCredentials) {
    joins.push(
      `LEFT JOIN (
        SELECT client_id AS clientId,
               MAX(status) AS mobileCredentialStatus,
               MAX(locked_until) AS mobileLockedUntil,
               MAX(password_changed_at) AS mobilePasswordChangedAt,
               MAX(updated_at) AS mobileCredentialUpdatedAt
        FROM api_v4_client_credentials
        GROUP BY client_id
      ) credentials ON credentials.clientId = cl.${qid(c.id)}`
    );
  }

  if (hasSessions) {
    joins.push(
      `LEFT JOIN (
        SELECT client_id AS clientId,
               COUNT(*) AS mobileSessionCount,
               COALESCE(SUM(CASE WHEN revoked_at IS NULL AND expires_at > NOW() THEN 1 ELSE 0 END), 0) AS activeMobileSessionCount,
               MAX(last_used_at) AS latestMobileSessionAt
        FROM api_v4_client_sessions
        GROUP BY client_id
      ) sessions ON sessions.clientId = cl.${qid(c.id)}`
    );
  }

  if (hasDevices) {
    joins.push(
      `LEFT JOIN (
        SELECT client_id AS clientId,
               COUNT(*) AS mobileDeviceCount,
               COALESCE(SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END), 0) AS activeMobileDeviceCount,
               MAX(${deviceActivityColumn ? qid(deviceActivityColumn) : 'NULL'}) AS latestMobileDeviceAt
        FROM api_v4_client_device_tokens
        GROUP BY client_id
      ) devices ON devices.clientId = cl.${qid(c.id)}`
    );
  }

  if (hasQueries) {
    joins.push(
      `LEFT JOIN (
        SELECT client_userid AS clientId,
               COUNT(*) AS queryCount,
               COALESCE(SUM(CASE WHEN LOWER(COALESCE(status, '')) NOT IN ('resolved', 'closed') THEN 1 ELSE 0 END), 0) AS openQueryCount,
               MAX(created_on) AS latestQueryAt,
               MAX(resolved_on) AS latestQueryResolvedAt
        FROM client_queries
        GROUP BY client_userid
      ) queries ON queries.clientId = cl.${qid(c.id)}`
    );
  }

  const where = [];
  const params = [];
  addEqual(where, params, `cl.${qid(c.id)}`, args.clientId);
  if (args.name) {
    where.push(`${clientNameExpression('cl', c.first, c.last, c.business)} LIKE ?`);
    params.push(like(args.name));
  }
  if (c.email) addLike(where, params, `cl.${qid(c.email)}`, args.email);
  if (c.phone) addLike(where, params, `cl.${qid(c.phone)}`, args.phone);
  if (c.gender) addLike(where, params, `cl.${qid(c.gender)}`, args.gender);
  if (c.business) addLike(where, params, `cl.${qid(c.business)}`, args.business);
  if (c.businessCategory) addLike(where, params, `cl.${qid(c.businessCategory)}`, args.businessCategory);
  if (c.location) addLike(where, params, `cl.${qid(c.location)}`, args.location);
  if (c.tier) addLike(where, params, `cl.${qid(c.tier)}`, args.category || args.tier);
  if (c.createdOn && args.createdFrom) {
    where.push(`cl.${qid(c.createdOn)} >= ?`);
    params.push(args.createdFrom);
  }
  if (c.createdOn && args.createdTo) {
    where.push(`cl.${qid(c.createdOn)} < DATE_ADD(?, INTERVAL 1 DAY)`);
    params.push(args.createdTo);
  }
  if (args.onlyWithActivity) {
    where.push(hasCargo ? 'COALESCE(cargo.cargoCount, 0) > 0' : '1 = 0');
  }
  if (args.search) {
    const searchParts = [`CAST(cl.${qid(c.id)} AS CHAR) LIKE ?`];
    params.push(like(args.search));
    for (const column of [c.first, c.last, c.email, c.phone, c.business, c.businessCategory, c.location, c.uid]) {
      if (column) {
        searchParts.push(`cl.${qid(column)} LIKE ?`);
        params.push(like(args.search));
      }
    }
    where.push(`(${searchParts.join(' OR ')})`);
  }

  const { limit, offset } = pagination(args);
  const orderDate = hasCargo ? 'cargo.lastCargoAt' : 'NULL';
  const createdDate = c.createdOn ? `cl.${qid(c.createdOn)}` : 'NULL';
  const sql = `
    SELECT cl.${qid(c.id)} AS clientId,
           ${columnExpression('cl', c.first)} AS firstName,
           ${columnExpression('cl', c.last)} AS lastName,
           ${clientNameExpression('cl', c.first, c.last, c.business)} AS clientName,
           ${columnExpression('cl', c.email)} AS email,
           ${columnExpression('cl', c.phone)} AS phone,
           ${columnExpression('cl', c.gender)} AS gender,
           ${columnExpression('cl', c.business)} AS business,
           ${columnExpression('cl', c.businessCategory)} AS businessCategory,
           ${columnExpression('cl', c.location)} AS location,
           ${columnExpression('cl', c.tier)} AS category,
           ${columnExpression('cl', c.clientType)} AS clientType,
           ${columnExpression('cl', c.flag)} AS flag,
           ${columnExpression('cl', c.photoUrl)} AS photoUrl,
           ${columnExpression('cl', c.uid)} AS uid,
           ${columnExpression('cl', c.dob)} AS dob,
           ${columnExpression('cl', c.alternatePhones)} AS alternatePhones,
           ${columnExpression('cl', c.occupations)} AS occupations,
           ${columnExpression('cl', c.interests)} AS interests,
           ${columnExpression('cl', c.businessSize)} AS businessSize,
           ${columnExpression('cl', c.businessOffering)} AS businessOffering,
           ${columnExpression('cl', c.goodsCategories)} AS goodsCategories,
           ${columnExpression('cl', c.serviceCategories)} AS serviceCategories,
           ${columnExpression('cl', c.createdBy)} AS createdBy,
           ${columnExpression('cl', c.createdOn)} AS createdOn,
           ${columnExpression('cl', c.recordedShipmentCount)} AS recordedShipmentCount,
           ${columnExpression('cl', c.recordedLastShipment)} AS recordedLastShipment,
           ${columnExpression('cl', c.relationEmployeeId)} AS relationEmployeeId,
           ${hasEmployee ? employeeNameExpression('rel') : 'NULL'} AS relationEmployeeName,
           ${hasCargo ? 'COALESCE(cargo.cargoCount, 0)' : 'NULL'} AS cargoCount,
           ${hasCargo ? 'COALESCE(cargo.shipmentCount, 0)' : 'NULL'} AS shipmentCount,
           ${hasCargo ? 'COALESCE(cargo.declaredPackages, 0)' : 'NULL'} AS declaredPackages,
           ${hasCargo ? 'COALESCE(cargo.totalWeight, 0)' : 'NULL'} AS totalWeight,
           ${hasCargo ? 'COALESCE(cargo.totalVolume, 0)' : 'NULL'} AS totalVolume,
           ${hasCargo ? 'COALESCE(cargo.collectedCargoCount, 0)' : 'NULL'} AS collectedCargoCount,
           ${hasCargo ? 'COALESCE(cargo.paidCargoCount, 0)' : 'NULL'} AS paidCargoCount,
           ${hasCargo ? 'cargo.firstCargoAt' : 'NULL'} AS firstCargoAt,
           ${hasCargo ? 'cargo.lastCargoAt' : 'NULL'} AS lastCargoAt,
           ${hasPackages ? 'COALESCE(packages.packageGroupCount, 0)' : 'NULL'} AS packageGroupCount,
           ${hasPackages ? 'COALESCE(packages.packageUnitCount, 0)' : 'NULL'} AS packageUnitCount,
           ${hasPackages ? 'COALESCE(packages.checkedPackageUnitCount, 0)' : 'NULL'} AS checkedPackageUnitCount,
           ${hasPackages ? 'packages.latestPackageAt' : 'NULL'} AS latestPackageAt,
           ${hasInvoice ? 'COALESCE(invoices.invoiceCount, 0)' : 'NULL'} AS invoiceCount,
           ${hasInvoice ? 'COALESCE(invoices.invoiceTotal, 0)' : 'NULL'} AS invoiceTotal,
           ${hasInvoice ? 'COALESCE(invoices.invoiceBalance, 0)' : 'NULL'} AS invoiceBalance,
           ${hasInvoice ? 'COALESCE(invoices.paidInvoiceCount, 0)' : 'NULL'} AS paidInvoiceCount,
           ${hasInvoice ? 'COALESCE(invoices.unpaidInvoiceCount, 0)' : 'NULL'} AS unpaidInvoiceCount,
           ${hasInvoice ? 'invoices.latestInvoiceAt' : 'NULL'} AS latestInvoiceAt,
           ${hasPayment ? 'COALESCE(payments.paymentCount, 0)' : 'NULL'} AS paymentCount,
           ${hasPayment ? 'COALESCE(payments.paymentTotal, 0)' : 'NULL'} AS paymentTotal,
           ${hasPayment ? 'COALESCE(payments.approvedPaymentTotal, 0)' : 'NULL'} AS approvedPaymentTotal,
           ${hasPayment ? 'COALESCE(payments.pendingPaymentTotal, 0)' : 'NULL'} AS pendingPaymentTotal,
           ${hasPayment ? 'payments.latestPaymentAt' : 'NULL'} AS latestPaymentAt,
           ${orderInfo?.table && orderInfo.columns.clientId ? 'COALESCE(orders.orderFormCount, 0)' : 'NULL'} AS orderFormCount,
           ${orderInfo?.table && orderInfo.columns.clientId ? 'COALESCE(orders.orderFormValue, 0)' : 'NULL'} AS orderFormValue,
           ${orderInfo?.table && orderInfo.columns.clientId ? 'orders.latestOrderFormAt' : 'NULL'} AS latestOrderFormAt,
           ${hasLeads ? '(COALESCE(leads_phone.leadCount, 0) + COALESCE(leads_email.leadCount, 0))' : 'NULL'} AS leadCount,
           ${hasLeads ? '(COALESCE(leads_phone.convertedLeadCount, 0) + COALESCE(leads_email.convertedLeadCount, 0))' : 'NULL'} AS convertedLeadCount,
           ${hasLeads ? `CASE
             WHEN leads_phone.latestLeadAt IS NULL THEN leads_email.latestLeadAt
             WHEN leads_email.latestLeadAt IS NULL THEN leads_phone.latestLeadAt
             ELSE GREATEST(leads_phone.latestLeadAt, leads_email.latestLeadAt)
           END` : 'NULL'} AS latestLeadAt,
           ${hasKycLinks ? 'COALESCE(kyc_links.kycLinkCount, 0)' : 'NULL'} AS kycLinkCount,
           ${hasKycLinks ? 'COALESCE(kyc_links.completedKycLinkCount, 0)' : 'NULL'} AS completedKycLinkCount,
           ${hasKycLinks ? 'kyc_links.latestKycLinkAt' : 'NULL'} AS latestKycLinkAt,
           ${hasKycLinks ? 'kyc_links.latestKycCompletedAt' : 'NULL'} AS latestKycCompletedAt,
           ${hasKycSubmissions ? 'COALESCE(kyc_submissions.kycSubmissionCount, 0)' : 'NULL'} AS kycSubmissionCount,
           ${hasKycSubmissions ? 'kyc_submissions.latestKycSubmissionAt' : 'NULL'} AS latestKycSubmissionAt,
           ${hasKycSubmissions ? 'kyc_submissions.latestKycUpdatedAt' : 'NULL'} AS latestKycUpdatedAt,
           ${hasCredentials ? 'credentials.mobileCredentialStatus' : 'NULL'} AS mobileCredentialStatus,
           ${hasCredentials ? 'credentials.mobileLockedUntil' : 'NULL'} AS mobileLockedUntil,
           ${hasCredentials ? 'credentials.mobilePasswordChangedAt' : 'NULL'} AS mobilePasswordChangedAt,
           ${hasSessions ? 'COALESCE(sessions.mobileSessionCount, 0)' : 'NULL'} AS mobileSessionCount,
           ${hasSessions ? 'COALESCE(sessions.activeMobileSessionCount, 0)' : 'NULL'} AS activeMobileSessionCount,
           ${hasSessions ? 'sessions.latestMobileSessionAt' : 'NULL'} AS latestMobileSessionAt,
           ${hasDevices ? 'COALESCE(devices.mobileDeviceCount, 0)' : 'NULL'} AS mobileDeviceCount,
           ${hasDevices ? 'COALESCE(devices.activeMobileDeviceCount, 0)' : 'NULL'} AS activeMobileDeviceCount,
           ${hasDevices ? 'devices.latestMobileDeviceAt' : 'NULL'} AS latestMobileDeviceAt,
           ${hasQueries ? 'COALESCE(queries.queryCount, 0)' : 'NULL'} AS queryCount,
           ${hasQueries ? 'COALESCE(queries.openQueryCount, 0)' : 'NULL'} AS openQueryCount,
           ${hasQueries ? 'queries.latestQueryAt' : 'NULL'} AS latestQueryAt,
           ${hasQueries ? 'queries.latestQueryResolvedAt' : 'NULL'} AS latestQueryResolvedAt
    FROM ${qid(info.table)} cl
    ${joins.join('\n    ')}
    ${whereSql(where)}
    ORDER BY COALESCE(${orderDate}, ${createdDate}) DESC,
             cl.${qid(c.id)} DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const rows = await queryRows(sql, [...joinParams, ...params]);
  return withPagination({ rows, sourceTable: info.table }, limit, offset);
}

async function getClient(args) {
  const list = await listClients({ clientId: args.clientId, limit: 1, offset: 0 });
  const client = list.rows[0] || null;
  if (!client) {
    return {
      client: null,
      cargo: [],
      shipments: [],
      packages: [],
      invoices: [],
      payments: [],
      orderForms: [],
      leads: [],
      kyc: { links: [], submissions: [] },
      queries: [],
      mobileAccess: null,
    };
  }

  const limit = clampInt(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const cargo = args.includeCargo && await tableExists('cargo')
    ? (await listCargo({ clientId: args.clientId, limit, offset: 0 })).rows
    : [];
  const shipments = args.includeShipments ? await loadClientShipments(args.clientId, limit) : [];
  const packages = args.includePackages ? await loadClientPackages(args.clientId, limit) : [];
  const invoices = args.includeInvoices ? await loadClientInvoices(args.clientId, limit) : [];
  const payments = args.includePayments ? await loadClientPayments(args.clientId, limit) : [];
  const orderForms = args.includeOrderForms && await resolveOrderFormInfo(false)
    ? (await listOrderFormReports({ clientId: args.clientId, limit, offset: 0, includeSummary: false })).rows
    : [];
  const leads = args.includeLeads ? await loadClientMatchedLeads(client, limit) : [];
  const kyc = args.includeKyc ? await loadClientKyc(args.clientId, limit) : { links: [], submissions: [] };
  const queries = args.includeQueries ? await loadClientQueries(args.clientId, limit) : [];
  const mobileAccess = args.includeMobileAccess ? await loadClientMobileAccess(args.clientId) : null;

  return {
    client,
    cargo,
    shipments,
    packages,
    invoices,
    payments,
    orderForms,
    leads,
    kyc,
    queries,
    mobileAccess,
  };
}

async function updateClient(args) {
  const info = await resolveClientsInfo(true);
  if (!args.dryRun && args.confirm !== true) {
    throw new Error('Set confirm to true to update a client record.');
  }

  let plan = null;
  const conn = await pool.getConnection();
  try {
    const current = await loadClientRow(conn, info, args.clientId);
    if (!current) {
      throw new Error('Client not found.');
    }

    plan = await buildClientUpdatePlan(conn, info, current, args);
    if (args.dryRun) {
      return {
        dryRun: true,
        clientId: args.clientId,
        actorId: args.actorId,
        current: clientEditableSnapshot(info, current),
        proposed: {
          changeCount: plan.changes.length,
          changes: plan.changes,
        },
      };
    }

    if (plan.changes.length > 0) {
      await conn.beginTransaction();
      try {
        const setClauses = [...plan.setClauses];
        if (info.columns.createdOn) {
          setClauses.push(`${qid(info.columns.createdOn)} = ${qid(info.columns.createdOn)}`);
        }
        const [result] = await conn.execute(
          `UPDATE ${qid(info.table)}
           SET ${setClauses.join(', ')}
           WHERE ${qid(info.columns.id)} = ?
           LIMIT 1`,
          [...plan.params, args.clientId]
        );
        if (!result || result.affectedRows <= 0) {
          throw new Error('Failed to update client record.');
        }
        await conn.commit();
      } catch (error) {
        await conn.rollback();
        throw error;
      }
    }
  } finally {
    conn.release();
  }

  const detail = args.includeAssociatedData
    ? await getClient({
      clientId: args.clientId,
      includeCargo: true,
      includeShipments: true,
      includePackages: true,
      includeInvoices: true,
      includePayments: true,
      includeOrderForms: true,
      includeLeads: true,
      includeKyc: true,
      includeQueries: true,
      includeMobileAccess: true,
      limit: DEFAULT_LIMIT,
    })
    : null;
  const summary = detail?.client
    || (await listClients({ clientId: args.clientId, limit: 1, offset: 0 })).rows[0]
    || null;

  return {
    action: 'update_client',
    clientId: args.clientId,
    actorId: args.actorId,
    changed: Boolean(plan && plan.changes.length > 0),
    changes: plan ? plan.changes : [],
    client: summary,
    detail: args.includeAssociatedData ? detail : undefined,
  };
}

async function loadClientRow(conn, info, clientId) {
  const rows = await connectionRows(
    conn,
    `SELECT *
     FROM ${qid(info.table)}
     WHERE ${qid(info.columns.id)} = ?
     LIMIT 1`,
    [clientId]
  );
  return rows[0] || null;
}

async function buildClientUpdatePlan(conn, info, current, args) {
  const c = info.columns;
  const plan = {
    setClauses: [],
    params: [],
    changes: [],
    providedFields: [],
  };
  const unsupportedFields = [];

  const addUnsupported = (field) => {
    if (!unsupportedFields.includes(field)) {
      unsupportedFields.push(field);
    }
  };
  const addText = (field, column, options = {}) => {
    if (!hasOwn(args, field)) {
      return;
    }
    plan.providedFields.push(field);
    if (!column) {
      addUnsupported(field);
      return;
    }
    const value = normalizeClientTextValue(args[field], field, options);
    addClientPlanChange(plan, current, column, field, value);
  };

  addText('firstName', c.first, { allowNull: false, nonEmpty: true, maxLength: 120 });
  addText('lastName', c.last, { allowNull: false, nonEmpty: true, maxLength: 120 });

  if (args.clearEmail === true) {
    plan.providedFields.push('clearEmail');
    if (!c.email) {
      addUnsupported('email');
    } else if (hasOwn(args, 'email') && normalizeClientTextValue(args.email, 'email', { maxLength: 190 }) !== null) {
      throw new Error('Provide either email or clearEmail, not both.');
    } else {
      addClientPlanChange(plan, current, c.email, 'email', null);
    }
  } else if (hasOwn(args, 'email')) {
    plan.providedFields.push('email');
    if (!c.email) {
      addUnsupported('email');
    } else {
      const email = normalizeClientTextValue(args.email, 'email', { maxLength: 190 });
      if (email === null) {
        throw new Error('Email cannot be blank; set clearEmail to true to remove it.');
      }
      if (!isValidEmail(email)) {
        throw new Error('Email must be a valid email address.');
      }
      await ensureClientUniqueValue(conn, info, c.email, email, args.clientId, 'email');
      addClientPlanChange(plan, current, c.email, 'email', email);
    }
  }

  if (hasOwn(args, 'phone')) {
    plan.providedFields.push('phone');
    if (!c.phone) {
      addUnsupported('phone');
    } else {
      const phone = normalizeClientTextValue(args.phone, 'phone', {
        allowNull: false,
        nonEmpty: true,
        maxLength: 80,
      });
      await ensureClientUniqueValue(conn, info, c.phone, phone, args.clientId, 'phone number');
      addClientPlanChange(plan, current, c.phone, 'phone', phone);
    }
  }

  addText('gender', c.gender, { maxLength: 20 });
  addText('business', c.business, { maxLength: 500 });
  addText('businessCategory', c.businessCategory, { maxLength: 500 });
  addText('location', c.location, { maxLength: 500 });

  if (hasOwn(args, 'clientType')) {
    plan.providedFields.push('clientType');
    if (!c.clientType) {
      addUnsupported('clientType');
    } else {
      addClientPlanChange(plan, current, c.clientType, 'clientType', args.clientType);
    }
  }

  addText('category', c.tier, { allowNull: false, nonEmpty: true, maxLength: 80 });
  addText('dob', c.dob, { maxLength: 40 });
  addText('photoUrl', c.photoUrl, { maxLength: 500 });

  if (hasOwn(args, 'relationEmployeeId')) {
    plan.providedFields.push('relationEmployeeId');
    if (!c.relationEmployeeId) {
      addUnsupported('relationEmployeeId');
    } else {
      const relationEmployeeId = nullableInt(args.relationEmployeeId);
      await validateRelationEmployee(conn, relationEmployeeId);
      addClientPlanChange(plan, current, c.relationEmployeeId, 'relationEmployeeId', relationEmployeeId);
    }
  }

  addText('alternatePhones', c.alternatePhones, { maxLength: 2000 });
  addText('occupations', c.occupations, { maxLength: 2000 });
  addText('interests', c.interests, { maxLength: 2000 });
  addText('businessSize', c.businessSize, { maxLength: 500 });
  addText('businessOffering', c.businessOffering, { maxLength: 500 });
  addText('goodsCategories', c.goodsCategories, { maxLength: 2000 });
  addText('serviceCategories', c.serviceCategories, { maxLength: 2000 });

  if (unsupportedFields.length > 0) {
    throw new Error(`This Clients table does not support updating: ${unsupportedFields.join(', ')}.`);
  }
  if (plan.providedFields.length === 0) {
    throw new Error('Provide at least one client field to update.');
  }

  return plan;
}

function addClientPlanChange(plan, current, column, field, value) {
  const from = current[column] ?? null;
  if (clientFieldValuesEqual(from, value)) {
    return;
  }
  plan.setClauses.push(`${qid(column)} = ?`);
  plan.params.push(value);
  plan.changes.push({
    field,
    column,
    from,
    to: value,
  });
}

function clientEditableSnapshot(info, row) {
  const c = info.columns;
  return {
    sourceTable: info.table,
    clientId: c.id ? row[c.id] ?? null : null,
    firstName: c.first ? row[c.first] ?? null : null,
    lastName: c.last ? row[c.last] ?? null : null,
    email: c.email ? row[c.email] ?? null : null,
    phone: c.phone ? row[c.phone] ?? null : null,
    gender: c.gender ? row[c.gender] ?? null : null,
    business: c.business ? row[c.business] ?? null : null,
    businessCategory: c.businessCategory ? row[c.businessCategory] ?? null : null,
    location: c.location ? row[c.location] ?? null : null,
    clientType: c.clientType ? row[c.clientType] ?? null : null,
    category: c.tier ? row[c.tier] ?? null : null,
    dob: c.dob ? row[c.dob] ?? null : null,
    photoUrl: c.photoUrl ? row[c.photoUrl] ?? null : null,
    relationEmployeeId: c.relationEmployeeId ? row[c.relationEmployeeId] ?? null : null,
    alternatePhones: c.alternatePhones ? row[c.alternatePhones] ?? null : null,
    occupations: c.occupations ? row[c.occupations] ?? null : null,
    interests: c.interests ? row[c.interests] ?? null : null,
    businessSize: c.businessSize ? row[c.businessSize] ?? null : null,
    businessOffering: c.businessOffering ? row[c.businessOffering] ?? null : null,
    goodsCategories: c.goodsCategories ? row[c.goodsCategories] ?? null : null,
    serviceCategories: c.serviceCategories ? row[c.serviceCategories] ?? null : null,
  };
}

async function ensureClientUniqueValue(conn, info, column, value, clientId, label) {
  if (value === null || String(value).trim() === '') {
    return;
  }
  const rows = await connectionRows(
    conn,
    `SELECT ${qid(info.columns.id)} AS clientId
     FROM ${qid(info.table)}
     WHERE LOWER(TRIM(${qid(column)})) = LOWER(TRIM(?))
       AND ${qid(info.columns.id)} <> ?
     LIMIT 1`,
    [value, clientId]
  );
  if (rows.length > 0) {
    throw new Error(`Another client (${rows[0].clientId}) already uses this ${label}.`);
  }
}

async function validateRelationEmployee(conn, employeeId) {
  if (employeeId === null) {
    return;
  }
  if (!await tableExists('employee')) {
    throw new Error('Employee table is not available for relation employee validation.');
  }

  const employeeIdColumn = await pickColumn('employee', ['employeeid', 'id', 'employee_id']);
  if (!employeeIdColumn) {
    throw new Error('No employee id column was found for relation employee validation.');
  }
  const positionColumn = await pickColumn('employee', ['position', 'job_title', 'title']);
  const departmentColumn = await pickColumn('employee', ['department', 'department_name']);
  const select = [`${qid(employeeIdColumn)} AS employeeId`];
  if (positionColumn) select.push(`${qid(positionColumn)} AS position`);
  if (departmentColumn) select.push(`${qid(departmentColumn)} AS department`);

  const rows = await connectionRows(
    conn,
    `SELECT ${select.join(', ')}
     FROM employee
     WHERE ${qid(employeeIdColumn)} = ?
     LIMIT 1`,
    [employeeId]
  );
  const employee = rows[0] || null;
  if (!employee) {
    throw new Error('Relation employee was not found.');
  }
  if (positionColumn || departmentColumn) {
    const roleText = `${employee.position || ''} ${employee.department || ''}`.toLowerCase();
    if (!roleText.includes('relation')) {
      throw new Error('relationEmployeeId must reference a client relations staff member.');
    }
  }
}

async function resolveClientsInfo(required = true) {
  const table = await resolveTable(['Clients', 'clients', 'client', 'customers']);
  if (!table) {
    if (required) {
      throw new Error("Required table 'Clients' was not found in the configured database.");
    }
    return null;
  }

  const columns = {
    id: await pickColumn(table, ['userid', 'id', 'client_id', 'customer_id']),
    first: await pickColumn(table, ['firstname', 'first_name', 'fname']),
    last: await pickColumn(table, ['lastname', 'last_name', 'surname', 'lname']),
    email: await pickColumn(table, ['email', 'client_email']),
    phone: await pickColumn(table, ['phonenumber', 'phone', 'client_phone', 'mobile']),
    gender: await pickColumn(table, ['gender']),
    createdOn: await pickColumn(table, ['createdon', 'created_at', 'created', 'created_date']),
    flag: await pickColumn(table, ['flag']),
    business: await pickColumn(table, ['business', 'company_name', 'company']),
    businessCategory: await pickColumn(table, ['businesscategory', 'business_category']),
    location: await pickColumn(table, ['Location', 'location']),
    createdBy: await pickColumn(table, ['createdby', 'created_by']),
    photoUrl: await pickColumn(table, ['photourl', 'photo_url', 'avatar_url']),
    uid: await pickColumn(table, ['uid']),
    tier: await pickColumn(table, ['category', 'tier']),
    recordedShipmentCount: await pickColumn(table, ['shipmentcount', 'shipment_count']),
    recordedLastShipment: await pickColumn(table, ['lastshipment', 'last_shipment']),
    dob: await pickColumn(table, ['dob', 'date_of_birth']),
    alternatePhones: await pickColumn(table, ['alternate_phones', 'alternatephones', 'alternate_phone', 'alt_phone']),
    occupations: await pickColumn(table, ['occupations', 'occupation']),
    interests: await pickColumn(table, ['interests', 'interest_categories']),
    businessSize: await pickColumn(table, ['business_size']),
    businessOffering: await pickColumn(table, ['business_offering']),
    goodsCategories: await pickColumn(table, ['goods_categories']),
    serviceCategories: await pickColumn(table, ['service_categories']),
    clientType: await pickColumn(table, ['client_type']),
    relationEmployeeId: await pickColumn(table, ['relation_employee_id']),
  };

  if (!columns.id) {
    if (required) {
      throw new Error(`No client id column was found in '${table}'.`);
    }
    return null;
  }

  return { table, columns };
}

function clientCargoActivityFilter(alias, args) {
  const where = [];
  const params = [];
  if (args.activeFrom) {
    where.push(`${alias}.\`cargocreatedon\` >= ?`);
    params.push(args.activeFrom);
  }
  if (args.activeTo) {
    where.push(`${alias}.\`cargocreatedon\` < DATE_ADD(?, INTERVAL 1 DAY)`);
    params.push(args.activeTo);
  }
  return { where, params };
}

async function loadClientShipments(clientId, limit) {
  if (!await tableExists('cargo') || !await tableExists('shipment')) {
    return [];
  }
  const safeLimit = clampInt(limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  return queryRows(
    `SELECT s.\`shipmentid\` AS shipmentId,
            s.\`shipmentname\` AS shipmentName,
            s.\`shipmentstatus\` AS shipmentStatus,
            s.\`shipmentmode\` AS shipmentMode,
            s.\`departuredate\` AS departureDate,
            s.\`arrivaldate\` AS arrivalDate,
            s.\`currentlocation\` AS currentLocation,
            s.\`createdon\` AS createdOn,
            COUNT(c.\`cargoid\`) AS cargoCount,
            COALESCE(SUM(c.\`packages\`), 0) AS declaredPackages,
            COALESCE(SUM(c.\`weight\`), 0) AS totalWeight,
            COALESCE(SUM(c.\`volume\`), 0) AS totalVolume,
            MAX(c.\`cargocreatedon\`) AS latestCargoAt
     FROM cargo c
     INNER JOIN shipment s ON s.\`shipmentid\` = c.\`shipmentid\`
     WHERE c.\`userid\` = ?
     GROUP BY s.\`shipmentid\`, s.\`shipmentname\`, s.\`shipmentstatus\`, s.\`shipmentmode\`, s.\`departuredate\`, s.\`arrivaldate\`, s.\`currentlocation\`, s.\`createdon\`
     ORDER BY latestCargoAt DESC, s.\`shipmentid\` DESC
     LIMIT ${safeLimit}`,
    [clientId]
  );
}

async function loadClientPackages(clientId, limit) {
  if (!await tableExists('cargo') || !await tableExists('cargo_packages')) {
    return [];
  }
  const hasShipment = await tableExists('shipment');
  const hasUnits = await tableExists('cargo_package_units');
  const safeLimit = clampInt(limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  return queryRows(
    `SELECT cp.\`id\` AS packageId,
            cp.\`package_code\` AS packageCode,
            cp.\`cargo_id\` AS cargoId,
            cp.\`content_id\` AS contentId,
            cp.\`content\` AS content,
            cp.\`value\` AS value,
            cp.\`quantity\` AS quantity,
            cp.\`package_type\` AS packageType,
            cp.\`package_image\` AS packageImage,
            cp.\`courier_tracking_number\` AS courierTrackingNumber,
            cp.\`created_at\` AS createdAt,
            cp.\`checked_at\` AS checkedAt,
            cp.\`checked_by\` AS checkedBy,
            c.\`trackingnumber\` AS cargoTrackingNumber,
            c.\`cargostatus\` AS cargoStatus,
            c.\`financestatus\` AS financeStatus,
            c.\`shipmentid\` AS shipmentId,
            ${hasShipment ? 's.`shipmentname`' : 'NULL'} AS shipmentName,
            ${hasUnits ? 'COALESCE(units.totalUnits, 0)' : 'NULL'} AS totalUnits,
            ${hasUnits ? 'COALESCE(units.checkedUnits, 0)' : 'NULL'} AS checkedUnits
     FROM cargo_packages cp
     INNER JOIN cargo c ON c.\`cargoid\` = cp.\`cargo_id\`
     ${hasShipment ? 'LEFT JOIN shipment s ON s.`shipmentid` = c.`shipmentid`' : ''}
     ${hasUnits ? `LEFT JOIN (
       SELECT package_id,
              COUNT(*) AS totalUnits,
              COALESCE(SUM(CASE WHEN checked_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS checkedUnits
       FROM cargo_package_units
       GROUP BY package_id
     ) units ON units.package_id = cp.id` : ''}
     WHERE c.\`userid\` = ?
     ORDER BY cp.\`created_at\` DESC, cp.\`id\` DESC
     LIMIT ${safeLimit}`,
    [clientId]
  );
}

async function loadClientInvoices(clientId, limit) {
  if (!await tableExists('invoice')) {
    return [];
  }
  const hasShipment = await tableExists('shipment');
  const safeLimit = clampInt(limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  return queryRows(
    `SELECT i.\`invoiceid\` AS invoiceId,
            i.\`invoicestatus\` AS invoiceStatus,
            i.\`invoicedate\` AS invoiceDate,
            i.\`clientid\` AS clientId,
            i.\`createdby\` AS createdBy,
            ${numericExpression('i.`invoicetotal`')} AS invoiceTotal,
            ${numericExpression('i.`invoicebalance`')} AS invoiceBalance,
            i.\`discount\` AS discount,
            i.\`shipmentid\` AS shipmentId,
            ${hasShipment ? 's.`shipmentname`' : 'NULL'} AS shipmentName,
            i.\`cargoid\` AS cargoId,
            i.\`shippingcost\` AS shippingCost,
            i.\`invoicelink\` AS invoiceLink,
            i.\`invoicetotalRMB\` AS invoiceTotalRmb,
            i.\`discountpercentage\` AS discountPercentage
     FROM invoice i
     ${hasShipment ? 'LEFT JOIN shipment s ON s.`shipmentid` = i.`shipmentid`' : ''}
     WHERE i.\`clientid\` = ?
     ORDER BY i.\`invoicedate\` DESC, i.\`invoiceid\` DESC
     LIMIT ${safeLimit}`,
    [clientId]
  );
}

async function loadClientPayments(clientId, limit) {
  if (!await tableExists('payment')) {
    return [];
  }
  const hasInvoice = await tableExists('invoice');
  const safeLimit = clampInt(limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  return queryRows(
    `SELECT p.\`paymentid\` AS paymentId,
            p.\`invoiceid\` AS invoiceId,
            ${hasInvoice ? 'i.`invoicestatus`' : 'NULL'} AS invoiceStatus,
            p.\`paymentamount\` AS paymentAmount,
            p.\`paymentstatus\` AS paymentStatus,
            p.\`proofofpayment\` AS proofOfPayment,
            p.\`paymentdate\` AS paymentDate,
            p.\`clientid\` AS clientId,
            p.\`reviewedon\` AS reviewedOn,
            p.\`notes\` AS notes,
            p.\`flag\` AS flag,
            p.\`transid\` AS transactionId
     FROM payment p
     ${hasInvoice ? 'LEFT JOIN invoice i ON i.`invoiceid` = p.`invoiceid`' : ''}
     WHERE p.\`clientid\` = ?
     ORDER BY p.\`paymentdate\` DESC, p.\`paymentid\` DESC
     LIMIT ${safeLimit}`,
    [clientId]
  );
}

async function loadClientKyc(clientId, limit) {
  const safeLimit = clampInt(limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const links = await tableExists('client_kyc_links')
    ? await queryRows(
      `SELECT id AS linkId,
              client_id AS clientId,
              status,
              client_name AS clientName,
              client_email AS clientEmail,
              client_phone AS clientPhone,
              created_by AS createdBy,
              created_at AS createdAt,
              completed_at AS completedAt
       FROM client_kyc_links
       WHERE client_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ${safeLimit}`,
      [clientId]
    )
    : [];

  if (!await tableExists('client_kyc_submissions')) {
    return { links, submissions: [] };
  }

  const hasBusinessSize = await hasColumn('client_kyc_submissions', 'business_size');
  const hasBusinessOffering = await hasColumn('client_kyc_submissions', 'business_offering');
  const hasTradeIntent = await hasColumn('client_kyc_submissions', 'trade_intent');
  const hasGoodsCategories = await hasColumn('client_kyc_submissions', 'goods_categories');
  const hasServiceCategories = await hasColumn('client_kyc_submissions', 'service_categories');
  const submissions = await queryRows(
    `SELECT id AS submissionId,
            link_id AS linkId,
            client_id AS clientId,
            first_name AS firstName,
            last_name AS lastName,
            email,
            phone,
            gender,
            client_type AS clientType,
            business,
            business_category AS businessCategory,
            ${hasBusinessSize ? 'business_size' : 'NULL'} AS businessSize,
            ${hasBusinessOffering ? 'business_offering' : 'NULL'} AS businessOffering,
            ${hasTradeIntent ? 'trade_intent' : 'NULL'} AS tradeIntent,
            ${hasGoodsCategories ? 'goods_categories' : 'NULL'} AS goodsCategories,
            ${hasServiceCategories ? 'service_categories' : 'NULL'} AS serviceCategories,
            location,
            dob,
            id_type AS idType,
            terms_accepted_at AS termsAcceptedAt,
            created_at AS createdAt,
            updated_at AS updatedAt
     FROM client_kyc_submissions
     WHERE client_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT ${safeLimit}`,
    [clientId]
  );

  return { links, submissions };
}

async function loadClientQueries(clientId, limit) {
  if (!await tableExists('client_queries')) {
    return [];
  }
  const hasEmployee = await tableExists('employee');
  const safeLimit = clampInt(limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  return queryRows(
    `SELECT cq.id AS queryId,
            cq.client_userid AS clientId,
            cq.title,
            cq.description,
            cq.urgency,
            cq.category,
            cq.status,
            cq.created_by AS createdBy,
            cq.created_on AS createdOn,
            cq.assigned_to AS assignedTo,
            ${hasEmployee ? employeeNameExpression('e') : 'NULL'} AS assignedToName,
            cq.assigned_department AS assignedDepartment,
            cq.due_on AS dueOn,
            cq.resolved_on AS resolvedOn,
            cq.resolution
     FROM client_queries cq
     ${hasEmployee ? 'LEFT JOIN employee e ON e.employeeid = cq.assigned_to' : ''}
     WHERE cq.client_userid = ?
     ORDER BY cq.created_on DESC, cq.id DESC
     LIMIT ${safeLimit}`,
    [clientId]
  );
}

async function loadClientMobileAccess(clientId) {
  const deviceActivityColumn = await tableExists('api_v4_client_device_tokens')
    ? await pickColumn('api_v4_client_device_tokens', ['updated_at', 'last_seen_at', 'created_at'])
    : null;
  const credentials = await tableExists('api_v4_client_credentials')
    ? await queryRows(
      `SELECT client_id AS clientId,
              status,
              failed_attempts AS failedAttempts,
              locked_until AS lockedUntil,
              password_changed_at AS passwordChangedAt,
              created_at AS createdAt,
              updated_at AS updatedAt
       FROM api_v4_client_credentials
       WHERE client_id = ?
       LIMIT 1`,
      [clientId]
    )
    : [];

  const sessions = await tableExists('api_v4_client_sessions')
    ? await queryRows(
      `SELECT COUNT(*) AS sessionCount,
              COALESCE(SUM(CASE WHEN revoked_at IS NULL AND expires_at > NOW() THEN 1 ELSE 0 END), 0) AS activeSessionCount,
              MAX(last_used_at) AS latestSessionAt,
              MAX(created_at) AS latestCreatedAt
       FROM api_v4_client_sessions
       WHERE client_id = ?`,
      [clientId]
    )
    : [];

  const devices = await tableExists('api_v4_client_device_tokens')
    ? await queryRows(
      `SELECT COALESCE(NULLIF(TRIM(platform), ''), 'unknown') AS platform,
              COUNT(*) AS deviceCount,
              COALESCE(SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END), 0) AS activeDeviceCount,
              MAX(${deviceActivityColumn ? qid(deviceActivityColumn) : 'NULL'}) AS latestDeviceAt
       FROM api_v4_client_device_tokens
       WHERE client_id = ?
       GROUP BY COALESCE(NULLIF(TRIM(platform), ''), 'unknown')
       ORDER BY deviceCount DESC`,
      [clientId]
    )
    : [];

  return {
    credentials: credentials[0] || null,
    sessions: sessions[0] || null,
    devices,
  };
}

async function listCargo(args) {
  await requireTable('cargo');
  const clientsTable = await resolveTable(['Clients', 'clients']);
  const hasShipment = await tableExists('shipment');
  const hasPackages = await tableExists('cargo_packages');
  const hasTracking = await hasColumn('cargo', 'trackingnumber');
  const hasCheckedPackages = await hasColumn('cargo', 'checkedpackages');
  const hasMissingPackages = await hasColumn('cargo', 'missingpackages');
  const hasConsignmentValue = await hasColumn('cargo', 'consignment_value');

  const select = [
    'c.`cargoid` AS cargoId',
    hasTracking ? 'c.`trackingnumber` AS trackingNumber' : 'NULL AS trackingNumber',
    'c.`userid` AS clientId',
    clientsTable ? "NULLIF(TRIM(CONCAT(COALESCE(cl.`firstname`, ''), ' ', COALESCE(cl.`lastname`, ''))), '') AS clientName" : 'NULL AS clientName',
    clientsTable ? 'cl.`phonenumber` AS clientPhone' : 'NULL AS clientPhone',
    clientsTable ? 'cl.`business` AS clientBusiness' : 'NULL AS clientBusiness',
    'c.`shipmentid` AS shipmentId',
    hasShipment ? 's.`shipmentname` AS shipmentName' : 'NULL AS shipmentName',
    hasShipment ? 's.`shipmentstatus` AS shipmentStatus' : 'NULL AS shipmentStatus',
    'c.`weight` AS weight',
    'c.`volume` AS volume',
    'c.`packages` AS declaredPackages',
    hasCheckedPackages ? 'c.`checkedpackages` AS checkedPackages' : 'NULL AS checkedPackages',
    hasMissingPackages ? 'c.`missingpackages` AS missingPackages' : 'NULL AS missingPackages',
    hasPackages ? 'COALESCE(pkg.packageGroups, 0) AS packageGroups' : 'NULL AS packageGroups',
    hasPackages ? 'COALESCE(pkg.packageUnits, 0) AS packageUnits' : 'NULL AS packageUnits',
    hasConsignmentValue ? 'c.`consignment_value` AS consignmentValue' : 'NULL AS consignmentValue',
    'c.`cargostatus` AS cargoStatus',
    'c.`financestatus` AS financeStatus',
    'c.`cargolocation` AS cargoLocation',
    'c.`dispatchstatus` AS dispatchStatus',
    'c.`courier` AS courier',
    'c.`couriercontact` AS courierContact',
    'c.`content` AS content',
    'c.`notes` AS notes',
    'c.`createdby` AS createdBy',
    'c.`cargocreatedon` AS createdOn',
  ];

  const joins = [];
  if (clientsTable) {
    joins.push(`LEFT JOIN ${qid(clientsTable)} cl ON cl.\`userid\` = c.\`userid\``);
  }
  if (hasShipment) {
    joins.push('LEFT JOIN `shipment` s ON s.`shipmentid` = c.`shipmentid`');
  }
  if (hasPackages) {
    joins.push(
      `LEFT JOIN (
        SELECT cargo_id, COUNT(*) AS packageGroups, COALESCE(SUM(quantity), 0) AS packageUnits
        FROM cargo_packages
        GROUP BY cargo_id
      ) pkg ON pkg.cargo_id = c.cargoid`
    );
  }

  const where = [];
  const params = [];
  addEqual(where, params, 'c.`cargoid`', args.cargoId);
  addEqual(where, params, 'c.`shipmentid`', args.shipmentId);
  addEqual(where, params, 'c.`userid`', args.clientId);
  addLike(where, params, 'c.`cargostatus`', args.status);
  addLike(where, params, 'c.`financestatus`', args.financeStatus);
  addLike(where, params, 'c.`cargolocation`', args.location);
  if (hasTracking) {
    addLike(where, params, 'c.`trackingnumber`', args.trackingNumber);
  }
  if (args.packageCode && hasPackages) {
    where.push('EXISTS (SELECT 1 FROM cargo_packages cp_filter WHERE cp_filter.cargo_id = c.cargoid AND cp_filter.package_code LIKE ?)');
    params.push(like(args.packageCode));
  }
  if (args.createdFrom) {
    where.push('c.`cargocreatedon` >= ?');
    params.push(args.createdFrom);
  }
  if (args.createdTo) {
    where.push('c.`cargocreatedon` < DATE_ADD(?, INTERVAL 1 DAY)');
    params.push(args.createdTo);
  }
  if (args.search) {
    const searchParts = ['c.`content` LIKE ?', 'c.`notes` LIKE ?', 'c.`cargolocation` LIKE ?'];
    params.push(like(args.search), like(args.search), like(args.search));
    if (hasTracking) {
      searchParts.push('c.`trackingnumber` LIKE ?');
      params.push(like(args.search));
    }
    if (clientsTable) {
      searchParts.push('cl.`firstname` LIKE ?', 'cl.`lastname` LIKE ?', 'cl.`business` LIKE ?', 'cl.`phonenumber` LIKE ?');
      params.push(like(args.search), like(args.search), like(args.search), like(args.search));
    }
    if (hasShipment) {
      searchParts.push('s.`shipmentname` LIKE ?');
      params.push(like(args.search));
    }
    where.push(`(${searchParts.join(' OR ')})`);
  }

  const { limit, offset } = pagination(args);
  const sql = `
    SELECT ${select.join(',\n           ')}
    FROM cargo c
    ${joins.join('\n    ')}
    ${whereSql(where)}
    ORDER BY c.cargocreatedon DESC, c.cargoid DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const rows = await queryRows(sql, params);
  return withPagination({ rows }, limit, offset);
}

async function getCargo(args) {
  const list = await listCargo({ cargoId: args.cargoId, limit: 1, offset: 0 });
  const cargo = list.rows[0] || null;
  if (!cargo) {
    return { cargo: null, packages: [], logs: [], collections: [] };
  }

  const packages = await listPackages({
    cargoId: args.cargoId,
    limit: args.packageLimit,
    offset: 0,
  });
  const collections = await loadCargoCollections(args.cargoId);
  const logs = args.includeLogs ? await loadSimpleLogs('cargolog', 'cargologid', 'cargoid', args.cargoId, args.logLimit) : [];

  return {
    cargo,
    packages: packages.rows,
    collections,
    logs,
  };
}

async function listPackages(args) {
  await requireTable('cargo_packages');
  const hasCargo = await tableExists('cargo');
  const hasShipment = await tableExists('shipment');
  const clientsTable = await resolveTable(['Clients', 'clients']);
  const hasUnits = await tableExists('cargo_package_units');
  const hasTracking = hasCargo && (await hasColumn('cargo', 'trackingnumber'));

  const select = [
    'cp.`id` AS packageId',
    'cp.`package_code` AS packageCode',
    'cp.`cargo_id` AS cargoId',
    'cp.`content_id` AS contentId',
    'cp.`content` AS content',
    'cp.`value` AS value',
    'cp.`quantity` AS quantity',
    'cp.`package_type` AS packageType',
    'cp.`package_image` AS packageImage',
    'cp.`courier_tracking_number` AS courierTrackingNumber',
    'cp.`created_at` AS createdAt',
    'cp.`checked_at` AS checkedAt',
    'cp.`checked_by` AS checkedBy',
    hasUnits ? 'COALESCE(units.totalUnits, 0) AS totalUnits' : 'NULL AS totalUnits',
    hasUnits ? 'COALESCE(units.checkedUnits, 0) AS checkedUnits' : 'NULL AS checkedUnits',
    hasCargo && hasTracking ? 'c.`trackingnumber` AS cargoTrackingNumber' : 'NULL AS cargoTrackingNumber',
    hasCargo ? 'c.`cargostatus` AS cargoStatus' : 'NULL AS cargoStatus',
    hasCargo ? 'c.`financestatus` AS financeStatus' : 'NULL AS financeStatus',
    hasCargo ? 'c.`shipmentid` AS shipmentId' : 'NULL AS shipmentId',
    hasShipment ? 's.`shipmentname` AS shipmentName' : 'NULL AS shipmentName',
    clientsTable ? 'c.`userid` AS clientId' : 'NULL AS clientId',
    clientsTable ? "NULLIF(TRIM(CONCAT(COALESCE(cl.`firstname`, ''), ' ', COALESCE(cl.`lastname`, ''))), '') AS clientName" : 'NULL AS clientName',
  ];

  const joins = [];
  if (hasCargo) {
    joins.push('LEFT JOIN `cargo` c ON c.`cargoid` = cp.`cargo_id`');
  }
  if (hasShipment) {
    joins.push('LEFT JOIN `shipment` s ON s.`shipmentid` = c.`shipmentid`');
  }
  if (clientsTable) {
    joins.push(`LEFT JOIN ${qid(clientsTable)} cl ON cl.\`userid\` = c.\`userid\``);
  }
  if (hasUnits) {
    joins.push(
      `LEFT JOIN (
        SELECT package_id,
               COUNT(*) AS totalUnits,
               COALESCE(SUM(CASE WHEN checked_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS checkedUnits
        FROM cargo_package_units
        GROUP BY package_id
      ) units ON units.package_id = cp.id`
    );
  }

  const where = [];
  const params = [];
  addEqual(where, params, 'cp.`id`', args.packageId);
  addEqual(where, params, 'cp.`cargo_id`', args.cargoId);
  addLike(where, params, 'cp.`package_code`', args.packageCode);
  addLike(where, params, 'cp.`courier_tracking_number`', args.courierTrackingNumber);
  addLike(where, params, 'cp.`content`', args.content);
  if (hasCargo) {
    addEqual(where, params, 'c.`shipmentid`', args.shipmentId);
  }
  if (typeof args.checked === 'boolean') {
    where.push(args.checked ? 'cp.`checked_at` IS NOT NULL' : 'cp.`checked_at` IS NULL');
  }
  if (args.search) {
    const searchParts = ['cp.`content` LIKE ?', 'cp.`package_code` LIKE ?', 'cp.`courier_tracking_number` LIKE ?'];
    params.push(like(args.search), like(args.search), like(args.search));
    if (hasTracking) {
      searchParts.push('c.`trackingnumber` LIKE ?');
      params.push(like(args.search));
    }
    if (clientsTable) {
      searchParts.push('cl.`firstname` LIKE ?', 'cl.`lastname` LIKE ?');
      params.push(like(args.search), like(args.search));
    }
    if (hasShipment) {
      searchParts.push('s.`shipmentname` LIKE ?');
      params.push(like(args.search));
    }
    where.push(`(${searchParts.join(' OR ')})`);
  }

  const { limit, offset } = pagination(args);
  const sql = `
    SELECT ${select.join(',\n           ')}
    FROM cargo_packages cp
    ${joins.join('\n    ')}
    ${whereSql(where)}
    ORDER BY cp.created_at DESC, cp.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  const rows = await queryRows(sql, params);
  return withPagination({ rows }, limit, offset);
}

async function getPackage(args) {
  if (!args.packageId && !args.packageCode) {
    throw new Error('Provide packageId or packageCode.');
  }

  const listArgs = {
    packageId: args.packageId,
    packageCode: args.packageCode,
    limit: 1,
    offset: 0,
  };
  const list = await listPackages(listArgs);
  const pkg = list.rows[0] || null;
  if (!pkg) {
    return { package: null, units: [], stageSummary: [] };
  }

  const packageId = Number(pkg.packageId);
  const units = args.includeUnits ? await loadPackageUnits(packageId, args.unitLimit) : [];
  const stageSummary = await loadPackageStageSummary(packageId);

  return {
    package: pkg,
    units,
    stageSummary,
  };
}

async function listShipments(args) {
  await requireTable('shipment');
  const hasCargo = await tableExists('cargo');
  const hasPackages = await tableExists('cargo_packages');
  const hasCalendar = await tableExists('shipmentcalendar');

  const select = [
    's.`shipmentid` AS shipmentId',
    's.`shipmentname` AS shipmentName',
    's.`shipmentstatus` AS shipmentStatus',
    's.`shipmentmode` AS shipmentMode',
    's.`departuredate` AS departureDate',
    's.`arrivaldate` AS arrivalDate',
    's.`currentlocation` AS currentLocation',
    's.`createdon` AS createdOn',
    hasCalendar ? 'sc.`shipmentcalendarid` AS calendarId' : 'NULL AS calendarId',
    hasCalendar ? 'sc.`calendarstatus` AS calendarStatus' : 'NULL AS calendarStatus',
    hasCalendar ? 'sc.`loadingdate` AS loadingDate' : 'NULL AS loadingDate',
    hasCalendar ? 'sc.`estimateddeparture` AS estimatedDeparture' : 'NULL AS estimatedDeparture',
    hasCalendar ? 'sc.`estimatedarrival` AS estimatedArrival' : 'NULL AS estimatedArrival',
    hasCalendar ? 'sc.`agent` AS agent' : 'NULL AS agent',
    hasCargo ? 'COALESCE(cs.cargoCount, 0) AS cargoCount' : 'NULL AS cargoCount',
    hasCargo ? 'COALESCE(cs.totalPackages, 0) AS declaredPackages' : 'NULL AS declaredPackages',
    hasCargo ? 'COALESCE(cs.totalWeight, 0) AS totalWeight' : 'NULL AS totalWeight',
    hasCargo ? 'COALESCE(cs.totalVolume, 0) AS totalVolume' : 'NULL AS totalVolume',
    hasPackages ? 'COALESCE(ps.packageGroups, 0) AS packageGroups' : 'NULL AS packageGroups',
    hasPackages ? 'COALESCE(ps.packageUnits, 0) AS packageUnits' : 'NULL AS packageUnits',
  ];

  const joins = [];
  if (hasCalendar) {
    joins.push(
      `LEFT JOIN (
        SELECT sc1.*
        FROM shipmentcalendar sc1
        INNER JOIN (
          SELECT shipmentid, MAX(shipmentcalendarid) AS max_id
          FROM shipmentcalendar
          GROUP BY shipmentid
        ) latest ON latest.max_id = sc1.shipmentcalendarid
      ) sc ON sc.shipmentid = s.shipmentid`
    );
  }
  if (hasCargo) {
    joins.push(
      `LEFT JOIN (
        SELECT shipmentid,
               COUNT(*) AS cargoCount,
               COALESCE(SUM(packages), 0) AS totalPackages,
               COALESCE(SUM(weight), 0) AS totalWeight,
               COALESCE(SUM(volume), 0) AS totalVolume
        FROM cargo
        GROUP BY shipmentid
      ) cs ON cs.shipmentid = s.shipmentid`
    );
  }
  if (hasPackages) {
    joins.push(
      `LEFT JOIN (
        SELECT c.shipmentid,
               COUNT(cp.id) AS packageGroups,
               COALESCE(SUM(cp.quantity), 0) AS packageUnits
        FROM cargo_packages cp
        INNER JOIN cargo c ON c.cargoid = cp.cargo_id
        GROUP BY c.shipmentid
      ) ps ON ps.shipmentid = s.shipmentid`
    );
  }

  const where = [];
  const params = [];
  addEqual(where, params, 's.`shipmentid`', args.shipmentId);
  addLike(where, params, 's.`shipmentstatus`', args.status);
  addLike(where, params, 's.`shipmentmode`', args.mode);
  addLike(where, params, 's.`currentlocation`', args.location);
  addDateRange(where, params, 's.`departuredate`', args.departureFrom, args.departureTo);
  addDateRange(where, params, 's.`arrivaldate`', args.arrivalFrom, args.arrivalTo);
  if (args.search) {
    where.push('(s.`shipmentname` LIKE ? OR s.`shipmentstatus` LIKE ? OR s.`shipmentmode` LIKE ? OR s.`currentlocation` LIKE ?)');
    params.push(like(args.search), like(args.search), like(args.search), like(args.search));
  }

  const { limit, offset } = pagination(args);
  const sql = `
    SELECT ${select.join(',\n           ')}
    FROM shipment s
    ${joins.join('\n    ')}
    ${whereSql(where)}
    ORDER BY s.createdon DESC, s.shipmentid DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  const rows = await queryRows(sql, params);
  return withPagination({ rows }, limit, offset);
}

async function getShipment(args) {
  const list = await listShipments({ shipmentId: args.shipmentId, limit: 1, offset: 0 });
  const shipment = list.rows[0] || null;
  if (!shipment) {
    return { shipment: null, cargo: [], calendar: [], logs: [], updates: [], budgets: [] };
  }

  const cargo = args.includeCargo
    ? (await listCargo({ shipmentId: args.shipmentId, limit: args.cargoLimit, offset: 0 })).rows
    : [];
  const calendar = await loadShipmentCalendar(args.shipmentId);
  const logs = args.includeLogs ? await loadSimpleLogs('shipmentlog', 'shipmentlogid', 'shipmentid', args.shipmentId, args.logLimit) : [];
  const updates = args.includeLogs ? await loadShipmentUpdates(args.shipmentId, args.logLimit) : [];
  const budgets = (await listShipmentBudgets({ shipmentId: args.shipmentId, budgetType: 'all', limit: 20, offset: 0 })).rows;

  return {
    shipment,
    cargo,
    calendar,
    logs,
    updates,
    budgets,
  };
}

async function listMonthlyBudgets(args) {
  await requireTable('monthly_budget_entry');
  const hasCategory = await tableExists('monthly_budget_category');
  const hasSplits = await tableExists('monthly_budget_entry_schedule_split');
  const hasPurchaseSchedule = await hasColumn('monthly_budget_entry', 'purchase_schedule');
  const hasPurchaseStatus = await hasColumn('monthly_budget_entry', 'purchase_status');

  const select = [
    'e.`id` AS budgetEntryId',
    "DATE_FORMAT(e.`budget_month`, '%Y-%m') AS budgetMonth",
    'e.`category_id` AS categoryId',
    hasCategory ? 'cat.`name` AS categoryName' : 'NULL AS categoryName',
    'e.`budget_item` AS budgetItem',
    'e.`currency` AS currency',
    'e.`amount` AS amount',
    'e.`spent_amount` AS spentAmount',
    '(COALESCE(e.`amount`, 0) - COALESCE(e.`spent_amount`, 0)) AS balance',
    hasPurchaseSchedule ? 'e.`purchase_schedule` AS purchaseSchedule' : 'NULL AS purchaseSchedule',
    hasPurchaseStatus ? 'e.`purchase_status` AS purchaseStatus' : 'NULL AS purchaseStatus',
    hasSplits ? 'COALESCE(ss.splitCount, 0) AS scheduleSplitCount' : 'NULL AS scheduleSplitCount',
    hasSplits ? 'COALESCE(ss.scheduledAmount, 0) AS scheduledAmount' : 'NULL AS scheduledAmount',
    hasSplits && hasPurchaseSchedule
      ? 'CASE WHEN COALESCE(ss.splitCount, 0) > 0 THEN COALESCE(ss.scheduledAmount, 0) WHEN e.`purchase_schedule` IS NOT NULL THEN COALESCE(e.`amount`, 0) ELSE 0 END AS effectiveScheduledAmount'
      : hasSplits
        ? 'COALESCE(ss.scheduledAmount, 0) AS effectiveScheduledAmount'
        : hasPurchaseSchedule
          ? 'CASE WHEN e.`purchase_schedule` IS NOT NULL THEN COALESCE(e.`amount`, 0) ELSE 0 END AS effectiveScheduledAmount'
          : '0 AS effectiveScheduledAmount',
    hasSplits ? 'ss.firstScheduleDate AS firstScheduleDate' : 'NULL AS firstScheduleDate',
    hasSplits ? 'ss.lastScheduleDate AS lastScheduleDate' : 'NULL AS lastScheduleDate',
    'e.`created_by` AS createdBy',
    'e.`created_on` AS createdOn',
    'e.`updated_on` AS updatedOn',
  ];

  const joins = [];
  if (hasCategory) {
    joins.push('LEFT JOIN `monthly_budget_category` cat ON cat.`id` = e.`category_id`');
  }
  if (hasSplits) {
    joins.push(
      `LEFT JOIN (
        SELECT entry_id,
               COUNT(*) AS splitCount,
               COALESCE(SUM(scheduled_amount), 0) AS scheduledAmount,
               MIN(schedule_date) AS firstScheduleDate,
               MAX(schedule_date) AS lastScheduleDate
        FROM monthly_budget_entry_schedule_split
        GROUP BY entry_id
      ) ss ON ss.entry_id = e.id`
    );
  }

  const where = [];
  const params = [];
  addMonthlyBudgetFilters(where, params, args, hasCategory);

  const { limit, offset } = pagination(args);
  const sql = `
    SELECT ${select.join(',\n           ')}
    FROM monthly_budget_entry e
    ${joins.join('\n    ')}
    ${whereSql(where)}
    ORDER BY e.budget_month DESC, e.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  const rows = await queryRows(sql, params);
  return withPagination({ rows }, limit, offset);
}

async function getMonthlyBudget(args) {
  await requireTable('monthly_budget_entry');

  if (args.budgetEntryId) {
    const entry = await loadMonthlyBudgetEntry(args.budgetEntryId);
    if (!entry) {
      return {
        budgetEntry: null,
        scheduleSplits: [],
        usage: { requisitionItems: [], paymentVoucherItems: [] },
      };
    }

    const scheduleSplits = args.includeScheduleSplits
      ? await loadMonthlyBudgetScheduleSplits(args.budgetEntryId)
      : [];
    const usage = args.includeUsage
      ? await loadMonthlyBudgetUsage(args.budgetEntryId, args.linkedLimit)
      : { requisitionItems: [], paymentVoucherItems: [] };

    return {
      budgetEntry: entry,
      period: budgetPeriodInfo(entry.budgetMonth),
      summary: summarizeMonthlyBudgetRows([entry]),
      scheduleSplits,
      usage,
    };
  }

  const budgetMonth = args.budgetMonth || currentBudgetPeriodKey();
  const list = await listMonthlyBudgets({
    ...args,
    budgetMonth,
    limit: args.limit,
    offset: args.offset,
  });
  const summary = await summarizeMonthlyBudgetPeriod({ ...args, budgetMonth });
  const entryIds = list.rows.map((row) => Number(row.budgetEntryId)).filter((id) => id > 0);
  const scheduleSplits = args.includeScheduleSplits
    ? await loadMonthlyBudgetScheduleSplitsForEntries(entryIds)
    : [];

  return {
    budgetMonth,
    period: budgetPeriodInfo(budgetMonth),
    summary,
    entries: list.rows,
    scheduleSplitsByEntry: groupScheduleSplits(scheduleSplits),
    pagination: list.pagination,
  };
}

async function listPurchaseSchedule(args) {
  await requireTable('monthly_budget_entry');
  const hasCategory = await tableExists('monthly_budget_category');
  const hasSplits = await tableExists('monthly_budget_entry_schedule_split');
  const hasPurchaseSchedule = await hasColumn('monthly_budget_entry', 'purchase_schedule');
  const hasPurchaseStatus = await hasColumn('monthly_budget_entry', 'purchase_status');

  const joins = [];
  if (hasCategory) {
    joins.push('LEFT JOIN `monthly_budget_category` cat ON cat.`id` = e.`category_id`');
  }
  if (hasSplits) {
    joins.push(
      `LEFT JOIN (
        SELECT entry_id,
               COUNT(*) AS splitCount,
               COALESCE(SUM(scheduled_amount), 0) AS scheduledAmount,
               MIN(schedule_date) AS firstScheduleDate,
               MAX(schedule_date) AS lastScheduleDate
        FROM monthly_budget_entry_schedule_split
        GROUP BY entry_id
      ) ss ON ss.entry_id = e.id`
    );
  }

  const where = [];
  const params = [];
  const scheduleFilters = [];
  if (hasPurchaseSchedule) {
    scheduleFilters.push('e.`purchase_schedule` IS NOT NULL');
  }
  if (hasSplits) {
    scheduleFilters.push('ss.splitCount > 0');
  }
  where.push(`(${scheduleFilters.length ? scheduleFilters.join(' OR ') : '1 = 0'})`);

  addMonthlyBudgetFilters(where, params, args, hasCategory);
  if (args.scheduledFrom) {
    const conditions = [];
    if (hasPurchaseSchedule) conditions.push('e.`purchase_schedule` >= ?');
    if (hasSplits) conditions.push('ss.lastScheduleDate >= ?');
    if (conditions.length > 0) {
      where.push(`(${conditions.join(' OR ')})`);
      if (hasPurchaseSchedule) params.push(args.scheduledFrom);
      if (hasSplits) params.push(args.scheduledFrom);
    }
  }
  if (args.scheduledTo) {
    const conditions = [];
    if (hasPurchaseSchedule) conditions.push('e.`purchase_schedule` <= ?');
    if (hasSplits) conditions.push('ss.firstScheduleDate <= ?');
    if (conditions.length > 0) {
      where.push(`(${conditions.join(' OR ')})`);
      if (hasPurchaseSchedule) params.push(args.scheduledTo);
      if (hasSplits) params.push(args.scheduledTo);
    }
  }
  const { limit, offset } = pagination(args);
  const sql = `
    SELECT e.id AS budgetEntryId,
           DATE_FORMAT(e.budget_month, '%Y-%m') AS budgetMonth,
           e.category_id AS categoryId,
           ${hasCategory ? 'cat.name' : 'NULL'} AS categoryName,
           e.budget_item AS budgetItem,
           e.currency AS currency,
           e.amount AS amount,
           e.spent_amount AS spentAmount,
           (COALESCE(e.amount, 0) - COALESCE(e.spent_amount, 0)) AS balance,
           ${hasPurchaseSchedule ? 'e.purchase_schedule' : 'NULL'} AS purchaseSchedule,
           ${hasPurchaseStatus ? 'e.purchase_status' : 'NULL'} AS purchaseStatus,
           ${hasSplits ? 'COALESCE(ss.splitCount, 0)' : 'NULL'} AS scheduleSplitCount,
           ${hasSplits ? 'COALESCE(ss.scheduledAmount, 0)' : 'NULL'} AS scheduledAmount,
           ${hasSplits && hasPurchaseSchedule
             ? 'CASE WHEN COALESCE(ss.splitCount, 0) > 0 THEN COALESCE(ss.scheduledAmount, 0) WHEN e.purchase_schedule IS NOT NULL THEN COALESCE(e.amount, 0) ELSE 0 END'
             : hasSplits
               ? 'COALESCE(ss.scheduledAmount, 0)'
               : hasPurchaseSchedule
                 ? 'CASE WHEN e.purchase_schedule IS NOT NULL THEN COALESCE(e.amount, 0) ELSE 0 END'
                 : '0'} AS effectiveScheduledAmount,
           ${hasSplits ? 'ss.firstScheduleDate' : 'NULL'} AS firstScheduleDate,
           ${hasSplits ? 'ss.lastScheduleDate' : 'NULL'} AS lastScheduleDate,
           e.updated_on AS updatedOn
    FROM monthly_budget_entry e
    ${joins.join('\n    ')}
    ${whereSql(where)}
    ORDER BY COALESCE(${hasSplits ? 'ss.firstScheduleDate' : 'NULL'}, ${hasPurchaseSchedule ? 'e.purchase_schedule' : 'NULL'}, e.updated_on) ASC,
             e.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  const rows = await queryRows(sql, params);
  return withPagination({ rows }, limit, offset);
}

async function scheduleBudgetPurchase(args) {
  await requireTable('monthly_budget_entry');
  if (!args.dryRun && args.confirm !== true) {
    throw new Error('Set confirm to true to schedule a monthly budget purchase.');
  }

  let proposal = null;
  const conn = await pool.getConnection();
  try {
    const entry = await loadMonthlyBudgetEntryForSchedule(conn, args.budgetEntryId);
    if (!entry) {
      throw new Error('Monthly budget entry not found.');
    }
    const splits = await loadMonthlyBudgetScheduleSplitsOnConnection(conn, args.budgetEntryId);
    proposal = await buildBudgetScheduleProposal(conn, entry, splits, args);

    if (args.dryRun) {
      return {
        dryRun: true,
        current: {
          budgetEntry: entry,
          scheduleSplits: splits,
        },
        proposed: proposal,
      };
    }

    await conn.beginTransaction();
    try {
      if (args.action === 'set_single_date' || args.action === 'clear_single_date') {
        await updateMonthlyBudgetPurchaseScheduleOnConnection(conn, args.budgetEntryId, proposal.toPurchaseSchedule);
      } else if (args.action === 'add_split') {
        await insertMonthlyBudgetScheduleSplitOnConnection(
          conn,
          args.budgetEntryId,
          proposal.split.scheduleDate,
          proposal.split.scheduledAmount,
          args.actorId
        );
        await syncMonthlyBudgetPurchaseScheduleFromSplitsOnConnection(conn, args.budgetEntryId);
      } else if (args.action === 'update_split') {
        await updateMonthlyBudgetScheduleSplitOnConnection(
          conn,
          args.budgetEntryId,
          args.splitId,
          proposal.split.scheduleDate,
          proposal.split.scheduledAmount
        );
        await syncMonthlyBudgetPurchaseScheduleFromSplitsOnConnection(conn, args.budgetEntryId);
      } else if (args.action === 'delete_split') {
        await deleteMonthlyBudgetScheduleSplitOnConnection(conn, args.budgetEntryId, args.splitId);
        await syncMonthlyBudgetPurchaseScheduleFromSplitsOnConnection(conn, args.budgetEntryId);
      }
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    }
  } finally {
    conn.release();
  }

  const detail = await getMonthlyBudget({
    budgetEntryId: args.budgetEntryId,
    includeScheduleSplits: true,
    includeUsage: false,
    linkedLimit: DEFAULT_LIMIT,
    limit: DEFAULT_LIMIT,
    offset: 0,
  });

  return {
    action: 'schedule_budget_purchase',
    scheduleAction: args.action,
    budgetEntryId: args.budgetEntryId,
    changed: true,
    proposed: proposal,
    budgetEntry: detail.budgetEntry,
    scheduleSplits: detail.scheduleSplits,
  };
}

function addMonthlyBudgetFilters(where, params, args, hasCategory) {
  addEqual(where, params, 'e.`id`', args.budgetEntryId);
  if (args.budgetMonth) {
    where.push('e.`budget_month` = ?');
    params.push(`${args.budgetMonth}-01`);
  }
  addEqual(where, params, 'e.`category_id`', args.categoryId);
  addLike(where, params, 'e.`currency`', args.currency);
  if (args.category && hasCategory) {
    addLike(where, params, 'cat.`name`', args.category);
  }
  if (args.search) {
    const parts = ['e.`budget_item` LIKE ?', 'e.`currency` LIKE ?'];
    params.push(like(args.search), like(args.search));
    if (hasCategory) {
      parts.push('cat.`name` LIKE ?');
      params.push(like(args.search));
    }
    where.push(`(${parts.join(' OR ')})`);
  }
}

async function loadMonthlyBudgetEntry(budgetEntryId) {
  const list = await listMonthlyBudgets({ budgetEntryId, limit: 1, offset: 0 });
  return list.rows[0] || null;
}

async function summarizeMonthlyBudgetPeriod(args) {
  const hasCategory = await tableExists('monthly_budget_category');
  const hasSplits = await tableExists('monthly_budget_entry_schedule_split');
  const hasPurchaseSchedule = await hasColumn('monthly_budget_entry', 'purchase_schedule');
  const joins = [];
  if (hasCategory) {
    joins.push('LEFT JOIN `monthly_budget_category` cat ON cat.`id` = e.`category_id`');
  }
  if (hasSplits) {
    joins.push(
      `LEFT JOIN (
        SELECT entry_id,
               COUNT(*) AS splitCount,
               COALESCE(SUM(scheduled_amount), 0) AS scheduledAmount
        FROM monthly_budget_entry_schedule_split
        GROUP BY entry_id
      ) ss ON ss.entry_id = e.id`
    );
  }

  const effectiveScheduledExpression = hasSplits && hasPurchaseSchedule
    ? 'CASE WHEN COALESCE(ss.splitCount, 0) > 0 THEN COALESCE(ss.scheduledAmount, 0) WHEN e.`purchase_schedule` IS NOT NULL THEN COALESCE(e.`amount`, 0) ELSE 0 END'
    : hasSplits
      ? 'COALESCE(ss.scheduledAmount, 0)'
      : hasPurchaseSchedule
        ? 'CASE WHEN e.`purchase_schedule` IS NOT NULL THEN COALESCE(e.`amount`, 0) ELSE 0 END'
        : '0';
  const where = [];
  const params = [];
  addMonthlyBudgetFilters(where, params, args, hasCategory);
  const rows = await queryRows(
    `SELECT e.currency,
            COUNT(*) AS entryCount,
            COALESCE(SUM(e.amount), 0) AS amount,
            COALESCE(SUM(e.spent_amount), 0) AS spentAmount,
            COALESCE(SUM(COALESCE(e.amount, 0) - COALESCE(e.spent_amount, 0)), 0) AS balance,
            COALESCE(SUM(${effectiveScheduledExpression}), 0) AS effectiveScheduledAmount
     FROM monthly_budget_entry e
     ${joins.join('\n     ')}
     ${whereSql(where)}
     GROUP BY e.currency
     ORDER BY e.currency ASC`,
    params
  );

  return {
    entryCount: rows.reduce((total, row) => total + Number(row.entryCount || 0), 0),
    byCurrency: rows.map((row) => ({
      currency: row.currency,
      entryCount: Number(row.entryCount || 0),
      amount: roundMoney(row.amount),
      spentAmount: roundMoney(row.spentAmount),
      balance: roundMoney(row.balance),
      effectiveScheduledAmount: roundMoney(row.effectiveScheduledAmount),
      unscheduledAmount: roundMoney(Number(row.amount || 0) - Number(row.effectiveScheduledAmount || 0)),
    })),
  };
}

function summarizeMonthlyBudgetRows(rows) {
  const totals = new Map();
  for (const row of rows) {
    const currency = String(row.currency || 'UNSPECIFIED').toUpperCase();
    const current = totals.get(currency) || {
      currency,
      entryCount: 0,
      amount: 0,
      spentAmount: 0,
      balance: 0,
      effectiveScheduledAmount: 0,
    };
    current.entryCount += 1;
    current.amount += Number(row.amount || 0);
    current.spentAmount += Number(row.spentAmount || 0);
    current.balance += Number(row.balance || 0);
    current.effectiveScheduledAmount += Number(row.effectiveScheduledAmount || 0);
    totals.set(currency, current);
  }
  return {
    entryCount: rows.length,
    byCurrency: [...totals.values()].map((row) => ({
      ...row,
      amount: roundMoney(row.amount),
      spentAmount: roundMoney(row.spentAmount),
      balance: roundMoney(row.balance),
      effectiveScheduledAmount: roundMoney(row.effectiveScheduledAmount),
      unscheduledAmount: roundMoney(row.amount - row.effectiveScheduledAmount),
    })),
  };
}

async function loadMonthlyBudgetScheduleSplits(budgetEntryId) {
  return loadMonthlyBudgetScheduleSplitsForEntries([budgetEntryId]);
}

async function loadMonthlyBudgetScheduleSplitsForEntries(entryIds) {
  if (!entryIds.length || !await tableExists('monthly_budget_entry_schedule_split')) {
    return [];
  }
  const safeIds = [...new Set(entryIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (!safeIds.length) {
    return [];
  }
  const placeholders = safeIds.map(() => '?').join(', ');
  const hasCreatedBy = await hasColumn('monthly_budget_entry_schedule_split', 'created_by');
  const hasCreatedOn = await hasColumn('monthly_budget_entry_schedule_split', 'created_on');
  const hasUpdatedOn = await hasColumn('monthly_budget_entry_schedule_split', 'updated_on');
  return queryRows(
    `SELECT id AS splitId,
            entry_id AS budgetEntryId,
            DATE_FORMAT(schedule_date, '%Y-%m-%d') AS scheduleDate,
            scheduled_amount AS scheduledAmount,
            ${hasCreatedBy ? 'created_by' : 'NULL'} AS createdBy,
            ${hasCreatedOn ? 'created_on' : 'NULL'} AS createdOn,
            ${hasUpdatedOn ? 'updated_on' : 'NULL'} AS updatedOn
     FROM monthly_budget_entry_schedule_split
     WHERE entry_id IN (${placeholders})
     ORDER BY schedule_date ASC, id ASC`,
    safeIds
  );
}

async function loadMonthlyBudgetScheduleSplitsOnConnection(conn, budgetEntryId) {
  if (!await tableExists('monthly_budget_entry_schedule_split')) {
    return [];
  }
  const hasCreatedBy = await hasColumn('monthly_budget_entry_schedule_split', 'created_by');
  const hasCreatedOn = await hasColumn('monthly_budget_entry_schedule_split', 'created_on');
  const hasUpdatedOn = await hasColumn('monthly_budget_entry_schedule_split', 'updated_on');
  return connectionRows(
    conn,
    `SELECT id AS splitId,
            entry_id AS budgetEntryId,
            DATE_FORMAT(schedule_date, '%Y-%m-%d') AS scheduleDate,
            scheduled_amount AS scheduledAmount,
            ${hasCreatedBy ? 'created_by' : 'NULL'} AS createdBy,
            ${hasCreatedOn ? 'created_on' : 'NULL'} AS createdOn,
            ${hasUpdatedOn ? 'updated_on' : 'NULL'} AS updatedOn
     FROM monthly_budget_entry_schedule_split
     WHERE entry_id = ?
     ORDER BY schedule_date ASC, id ASC`,
    [budgetEntryId]
  );
}

function groupScheduleSplits(rows) {
  const grouped = {};
  for (const row of rows) {
    const key = String(row.budgetEntryId);
    if (!grouped[key]) {
      grouped[key] = [];
    }
    grouped[key].push(row);
  }
  return grouped;
}

async function loadMonthlyBudgetUsage(budgetEntryId, limit) {
  const safeLimit = clampInt(limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const requisitionItems = await loadMonthlyBudgetRequisitionItems(budgetEntryId, safeLimit);
  const paymentVoucherItems = await loadMonthlyBudgetPaymentVoucherItems(budgetEntryId, safeLimit);
  return {
    requisitionItems,
    paymentVoucherItems,
  };
}

async function loadMonthlyBudgetRequisitionItems(budgetEntryId, limit) {
  if (!await tableExists('requisition_items')) {
    return [];
  }
  const hasRequisitions = await tableExists('requisitions');
  const hasShipmentId = await hasColumn('requisition_items', 'shipment_id');
  const monthlyGuard = hasShipmentId ? 'AND (ri.shipment_id IS NULL OR ri.shipment_id = 0)' : '';
  return queryRows(
    `SELECT ri.id AS itemId,
            ri.requisition_id AS requisitionId,
            ${hasRequisitions ? 'r.title' : 'NULL'} AS requisitionTitle,
            ${hasRequisitions ? 'r.status' : 'NULL'} AS requisitionStatus,
            ${hasRequisitions ? 'r.stage' : 'NULL'} AS requisitionStage,
            ri.item_name AS itemName,
            ri.quantity,
            ri.unit_price AS unitPrice,
            ri.currency,
            (ri.quantity * ri.unit_price) AS lineTotal,
            ri.created_at AS createdAt
     FROM requisition_items ri
     ${hasRequisitions ? 'LEFT JOIN requisitions r ON r.id = ri.requisition_id' : ''}
     WHERE ri.budget_item_id = ?
       ${monthlyGuard}
     ORDER BY ri.created_at DESC, ri.id DESC
     LIMIT ${limit}`,
    [budgetEntryId]
  );
}

async function loadMonthlyBudgetPaymentVoucherItems(budgetEntryId, limit) {
  if (!await tableExists('payment_voucher_items')) {
    return [];
  }
  const hasBudgetItemId = await hasColumn('payment_voucher_items', 'budget_item_id');
  if (!hasBudgetItemId) {
    return [];
  }
  const hasPaymentVouchers = await tableExists('payment_vouchers');
  const hasShipmentId = await hasColumn('payment_voucher_items', 'shipment_id');
  const hasAllocatedAmount = await hasColumn('payment_voucher_items', 'allocated_amount');
  const monthlyGuard = hasShipmentId ? 'AND (pvi.shipment_id IS NULL OR pvi.shipment_id = 0)' : '';
  return queryRows(
    `SELECT pvi.id AS itemId,
            pvi.voucher_id AS voucherId,
            ${hasPaymentVouchers ? 'pv.status' : 'NULL'} AS voucherStatus,
            ${hasPaymentVouchers ? 'pv.recipient_name' : 'NULL'} AS recipientName,
            pvi.item_name AS itemName,
            pvi.quantity,
            pvi.unit_price AS unitPrice,
            pvi.currency,
            ${hasAllocatedAmount ? 'pvi.allocated_amount' : 'NULL'} AS allocatedAmount,
            (pvi.quantity * pvi.unit_price) AS lineTotal,
            pvi.created_at AS createdAt
     FROM payment_voucher_items pvi
     ${hasPaymentVouchers ? 'LEFT JOIN payment_vouchers pv ON pv.id = pvi.voucher_id' : ''}
     WHERE pvi.budget_item_id = ?
       ${monthlyGuard}
     ORDER BY pvi.created_at DESC, pvi.id DESC
     LIMIT ${limit}`,
    [budgetEntryId]
  );
}

async function loadMonthlyBudgetEntryForSchedule(conn, budgetEntryId) {
  const hasCategory = await tableExists('monthly_budget_category');
  const hasPurchaseSchedule = await hasColumn('monthly_budget_entry', 'purchase_schedule');
  const hasPurchaseStatus = await hasColumn('monthly_budget_entry', 'purchase_status');
  const rows = await connectionRows(
    conn,
    `SELECT e.id AS budgetEntryId,
            DATE_FORMAT(e.budget_month, '%Y-%m') AS budgetMonth,
            e.category_id AS categoryId,
            ${hasCategory ? 'cat.name' : 'NULL'} AS categoryName,
            e.budget_item AS budgetItem,
            e.currency,
            e.amount,
            e.spent_amount AS spentAmount,
            (COALESCE(e.amount, 0) - COALESCE(e.spent_amount, 0)) AS balance,
            ${hasPurchaseSchedule ? 'e.purchase_schedule' : 'NULL'} AS purchaseSchedule,
            ${hasPurchaseStatus ? 'e.purchase_status' : 'NULL'} AS purchaseStatus,
            e.created_by AS createdBy,
            e.created_on AS createdOn,
            e.updated_on AS updatedOn
     FROM monthly_budget_entry e
     ${hasCategory ? 'LEFT JOIN monthly_budget_category cat ON cat.id = e.category_id' : ''}
     WHERE e.id = ?
     LIMIT 1`,
    [budgetEntryId]
  );
  return rows[0] || null;
}

async function buildBudgetScheduleProposal(conn, entry, splits, args) {
  const action = args.action;
  const amount = roundMoney(entry.amount);
  const currentSplitTotal = roundMoney(splits.reduce((total, split) => total + Number(split.scheduledAmount || 0), 0));

  if (action === 'set_single_date') {
    if (!args.scheduleDate) {
      throw new Error('scheduleDate is required when setting a purchase schedule.');
    }
    await requireMonthlyBudgetPurchaseScheduleColumn();
    return {
      action,
      budgetEntryId: args.budgetEntryId,
      fromPurchaseSchedule: emptyToNull(entry.purchaseSchedule),
      toPurchaseSchedule: args.scheduleDate,
      splitCount: splits.length,
      note: splits.length > 0 ? 'Existing split schedule rows are preserved.' : null,
    };
  }

  if (action === 'clear_single_date') {
    await requireMonthlyBudgetPurchaseScheduleColumn();
    return {
      action,
      budgetEntryId: args.budgetEntryId,
      fromPurchaseSchedule: emptyToNull(entry.purchaseSchedule),
      toPurchaseSchedule: null,
      splitCount: splits.length,
      note: splits.length > 0 ? 'Existing split schedule rows are preserved.' : null,
    };
  }

  await requireTable('monthly_budget_entry_schedule_split');
  const split = args.splitId ? splits.find((row) => Number(row.splitId) === Number(args.splitId)) : null;

  if (action === 'add_split') {
    const newSplit = validateBudgetScheduleSplitInput(args);
    ensureBudgetScheduleAmountWithinBudget(amount, currentSplitTotal + newSplit.scheduledAmount);
    const projectedSplits = [...splits, newSplit];
    return {
      action,
      budgetEntryId: args.budgetEntryId,
      budgetAmount: amount,
      currentSplitTotal,
      projectedSplitTotal: roundMoney(currentSplitTotal + newSplit.scheduledAmount),
      remainingAfterChange: roundMoney(amount - currentSplitTotal - newSplit.scheduledAmount),
      syncPurchaseScheduleTo: earliestScheduleDate(projectedSplits),
      split: newSplit,
    };
  }

  if (!split) {
    throw new Error('Selected split schedule was not found for this budget entry.');
  }

  if (action === 'update_split') {
    const nextSplit = validateBudgetScheduleSplitInput(args);
    nextSplit.splitId = args.splitId;
    const otherSplitTotal = roundMoney(currentSplitTotal - Number(split.scheduledAmount || 0));
    ensureBudgetScheduleAmountWithinBudget(amount, otherSplitTotal + nextSplit.scheduledAmount);
    const projectedSplits = splits.map((row) => Number(row.splitId) === Number(args.splitId) ? nextSplit : row);
    return {
      action,
      budgetEntryId: args.budgetEntryId,
      splitId: args.splitId,
      budgetAmount: amount,
      currentSplitTotal,
      projectedSplitTotal: roundMoney(otherSplitTotal + nextSplit.scheduledAmount),
      remainingAfterChange: roundMoney(amount - otherSplitTotal - nextSplit.scheduledAmount),
      syncPurchaseScheduleTo: earliestScheduleDate(projectedSplits),
      fromSplit: split,
      split: nextSplit,
    };
  }

  if (action === 'delete_split') {
    const projectedSplits = splits.filter((row) => Number(row.splitId) !== Number(args.splitId));
    const projectedSplitTotal = roundMoney(currentSplitTotal - Number(split.scheduledAmount || 0));
    return {
      action,
      budgetEntryId: args.budgetEntryId,
      splitId: args.splitId,
      budgetAmount: amount,
      currentSplitTotal,
      projectedSplitTotal,
      remainingAfterChange: roundMoney(amount - projectedSplitTotal),
      syncPurchaseScheduleTo: earliestScheduleDate(projectedSplits),
      deleteSplit: split,
    };
  }

  throw new Error(`Unsupported schedule action: ${action}`);
}

function validateBudgetScheduleSplitInput(args) {
  if (!args.scheduleDate) {
    throw new Error('scheduleDate is required for split purchase schedules.');
  }
  if (args.scheduledAmount === undefined || args.scheduledAmount === null) {
    throw new Error('scheduledAmount is required for split purchase schedules.');
  }
  return {
    scheduleDate: args.scheduleDate,
    scheduledAmount: roundMoney(args.scheduledAmount),
  };
}

function ensureBudgetScheduleAmountWithinBudget(budgetAmount, projectedSplitTotal) {
  if (projectedSplitTotal > budgetAmount + 0.00001) {
    throw new Error('Split schedule total cannot exceed the monthly budget item amount.');
  }
}

function earliestScheduleDate(splits) {
  const dates = splits
    .map((split) => split.scheduleDate)
    .filter(Boolean)
    .sort();
  return dates[0] || null;
}

async function requireMonthlyBudgetPurchaseScheduleColumn() {
  if (!await hasColumn('monthly_budget_entry', 'purchase_schedule')) {
    throw new Error("Required column 'monthly_budget_entry.purchase_schedule' was not found.");
  }
}

async function updateMonthlyBudgetPurchaseScheduleOnConnection(conn, budgetEntryId, scheduleDate) {
  await requireMonthlyBudgetPurchaseScheduleColumn();
  const setParts = ['purchase_schedule = ?'];
  if (await hasColumn('monthly_budget_entry', 'updated_on')) {
    setParts.push('updated_on = NOW()');
  }
  const [result] = await conn.execute(
    `UPDATE monthly_budget_entry
     SET ${setParts.join(', ')}
     WHERE id = ?
     LIMIT 1`,
    [scheduleDate, budgetEntryId]
  );
  if (!result || result.affectedRows <= 0) {
    throw new Error('Failed to update purchase schedule.');
  }
}

async function insertMonthlyBudgetScheduleSplitOnConnection(conn, budgetEntryId, scheduleDate, scheduledAmount, actorId) {
  await requireTable('monthly_budget_entry_schedule_split');
  const columns = ['entry_id', 'schedule_date', 'scheduled_amount'];
  const placeholders = ['?', '?', '?'];
  const params = [budgetEntryId, scheduleDate, scheduledAmount];
  if (await hasColumn('monthly_budget_entry_schedule_split', 'created_by')) {
    columns.push('created_by');
    placeholders.push('?');
    params.push(String(actorId));
  }
  const [result] = await conn.execute(
    `INSERT INTO monthly_budget_entry_schedule_split (${columns.map(qid).join(', ')})
     VALUES (${placeholders.join(', ')})`,
    params
  );
  if (!result || result.affectedRows <= 0) {
    throw new Error('Failed to add split purchase schedule.');
  }
}

async function updateMonthlyBudgetScheduleSplitOnConnection(conn, budgetEntryId, splitId, scheduleDate, scheduledAmount) {
  await requireTable('monthly_budget_entry_schedule_split');
  const setParts = ['schedule_date = ?', 'scheduled_amount = ?'];
  if (await hasColumn('monthly_budget_entry_schedule_split', 'updated_on')) {
    setParts.push('updated_on = NOW()');
  }
  const [result] = await conn.execute(
    `UPDATE monthly_budget_entry_schedule_split
     SET ${setParts.join(', ')}
     WHERE id = ? AND entry_id = ?
     LIMIT 1`,
    [scheduleDate, scheduledAmount, splitId, budgetEntryId]
  );
  if (!result || result.affectedRows <= 0) {
    throw new Error('Failed to update split purchase schedule.');
  }
}

async function deleteMonthlyBudgetScheduleSplitOnConnection(conn, budgetEntryId, splitId) {
  await requireTable('monthly_budget_entry_schedule_split');
  const [result] = await conn.execute(
    `DELETE FROM monthly_budget_entry_schedule_split
     WHERE id = ? AND entry_id = ?
     LIMIT 1`,
    [splitId, budgetEntryId]
  );
  if (!result || result.affectedRows <= 0) {
    throw new Error('Failed to delete split purchase schedule.');
  }
}

async function syncMonthlyBudgetPurchaseScheduleFromSplitsOnConnection(conn, budgetEntryId) {
  if (!await hasColumn('monthly_budget_entry', 'purchase_schedule')) {
    return null;
  }
  const rows = await connectionRows(
    conn,
    `SELECT MIN(schedule_date) AS nextDate
     FROM monthly_budget_entry_schedule_split
     WHERE entry_id = ?`,
    [budgetEntryId]
  );
  const nextDate = emptyToNull(rows[0]?.nextDate);
  await updateMonthlyBudgetPurchaseScheduleOnConnection(conn, budgetEntryId, nextDate);
  return nextDate;
}

function currentBudgetPeriodKey(date = new Date()) {
  const current = new Date(date.getFullYear(), date.getMonth(), 1);
  if (date.getDate() >= 18) {
    current.setMonth(current.getMonth() + 1);
  }
  return `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}`;
}

function budgetPeriodInfo(periodKey) {
  const normalized = String(periodKey || currentBudgetPeriodKey());
  const [yearPart, monthPart] = normalized.split('-');
  const endMonth = new Date(Date.UTC(Number(yearPart), Number(monthPart) - 1, 1));
  const startMonth = new Date(Date.UTC(Number(yearPart), Number(monthPart) - 2, 1));
  const startYear = startMonth.getUTCFullYear();
  const startMonthNumber = startMonth.getUTCMonth() + 1;
  const endYear = endMonth.getUTCFullYear();
  const endMonthNumber = endMonth.getUTCMonth() + 1;
  const startLabel = monthName(startMonth);
  const endLabel = monthName(endMonth);
  const label = startYear === endYear
    ? `${startLabel} - ${endLabel} ${endYear} Budget`
    : `${startLabel} ${startYear} - ${endLabel} ${endYear} Budget`;
  return {
    key: normalized,
    storageDate: `${normalized}-01`,
    policyStart: `${startYear}-${String(startMonthNumber).padStart(2, '0')}-18`,
    policyEndExclusive: `${endYear}-${String(endMonthNumber).padStart(2, '0')}-18`,
    label,
  };
}

function monthName(date) {
  return date.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
}

async function listShipmentBudgets(args) {
  const budgetType = args.budgetType || 'all';
  const rows = [];

  if ((budgetType === 'all' || budgetType === 'customs') && await tableExists('shipment_budget')) {
    rows.push(...await loadShipmentBudgetRows({
      budgetTable: 'shipment_budget',
      incomeTable: 'shipment_budget_income',
      itemTable: 'shipment_budget_item',
      type: 'customs',
      budgetId: args.budgetId,
      shipmentId: args.shipmentId,
      search: args.search,
    }));
  }

  if ((budgetType === 'all' || budgetType === 'shipping') && await tableExists('shipping_shipment_budget')) {
    rows.push(...await loadShipmentBudgetRows({
      budgetTable: 'shipping_shipment_budget',
      incomeTable: 'shipping_shipment_budget_income',
      itemTable: 'shipping_shipment_budget_item',
      type: 'shipping',
      budgetId: args.budgetId,
      shipmentId: args.shipmentId,
      search: args.search,
    }));
  }

  rows.sort((a, b) => String(b.updatedOn || b.createdOn || '').localeCompare(String(a.updatedOn || a.createdOn || '')));
  const { limit, offset } = pagination(args);
  return withPagination({ rows: rows.slice(offset, offset + limit) }, limit, offset, rows.length);
}

async function getShipmentBudget(args) {
  const config = shipmentBudgetConfig(args.budgetType || 'customs');
  return loadShipmentBudgetDetail(config, args);
}

async function listCustomsBudgets(args) {
  return listShipmentBudgets({ ...args, budgetType: 'customs' });
}

async function getCustomsBudget(args) {
  return loadShipmentBudgetDetail(shipmentBudgetConfig('customs'), args);
}

async function listShippingBudgets(args) {
  return listShipmentBudgets({ ...args, budgetType: 'shipping' });
}

async function getShippingBudget(args) {
  return loadShipmentBudgetDetail(shipmentBudgetConfig('shipping'), args);
}

async function listRequisitions(args) {
  await requireTable('requisitions');
  const hasItems = await tableExists('requisition_items');
  const hasVouchers = await tableExists('payment_vouchers');
  const employeeTable = await resolveTable(['employee']);

  const joins = [];
  if (employeeTable) {
    joins.push(`LEFT JOIN ${qid(employeeTable)} req ON req.\`employeeid\` = r.\`requested_by\``);
  }
  if (hasItems) {
    joins.push(
      `LEFT JOIN (
        SELECT requisition_id,
               COUNT(*) AS itemCount,
               COALESCE(SUM(quantity * unit_price), 0) AS itemTotal
        FROM requisition_items
        GROUP BY requisition_id
      ) ri ON ri.requisition_id = r.id`
    );
  }
  if (hasVouchers) {
    joins.push(
      `LEFT JOIN (
        SELECT pv.requisition_id,
               COUNT(*) AS voucherCount,
               COALESCE(SUM(CASE WHEN COALESCE(pv.status, 'submitted') IN ('submitted','approved','paid','purchased') THEN COALESCE(pv.total_spent, totals.totalAmount, 0) ELSE 0 END), 0) AS reservedTotal,
               COALESCE(SUM(CASE WHEN COALESCE(pv.status, 'submitted') IN ('paid','purchased') THEN COALESCE(pv.total_spent, totals.totalAmount, 0) ELSE 0 END), 0) AS paidTotal
        FROM payment_vouchers pv
        LEFT JOIN (
          SELECT voucher_id, SUM(quantity * unit_price) AS totalAmount
          FROM payment_voucher_items
          GROUP BY voucher_id
        ) totals ON totals.voucher_id = pv.id
        GROUP BY pv.requisition_id
      ) pv ON pv.requisition_id = r.id`
    );
  }

  const where = [];
  const params = [];
  addEqual(where, params, 'r.`id`', args.requisitionId);
  addLike(where, params, 'r.`status`', args.status);
  addLike(where, params, 'r.`stage`', args.stage);
  if (args.approvedOnly) {
    where.push('r.`management_approved_at` IS NOT NULL');
  }
  if (args.requestedFrom) {
    where.push('r.`requested_on` >= ?');
    params.push(args.requestedFrom);
  }
  if (args.requestedTo) {
    where.push('r.`requested_on` < DATE_ADD(?, INTERVAL 1 DAY)');
    params.push(args.requestedTo);
  }
  if (args.search) {
    const parts = ['r.`title` LIKE ?', 'r.`description` LIKE ?', 'r.`status` LIKE ?', 'r.`stage` LIKE ?'];
    params.push(like(args.search), like(args.search), like(args.search), like(args.search));
    if (employeeTable) {
      parts.push('req.`firstname` LIKE ?', 'req.`lastname` LIKE ?', 'req.`email` LIKE ?');
      params.push(like(args.search), like(args.search), like(args.search));
    }
    where.push(`(${parts.join(' OR ')})`);
  }

  const { limit, offset } = pagination(args);
  const sql = `
    SELECT r.id AS requisitionId,
           r.title AS title,
           r.description AS description,
           r.currency AS currency,
           r.payment_method AS paymentMethod,
           r.status AS status,
           r.stage AS stage,
           r.total_amount AS totalAmount,
           r.requested_by AS requestedBy,
           ${employeeTable ? "NULLIF(TRIM(CONCAT(COALESCE(req.firstname, ''), ' ', COALESCE(req.lastname, ''))), '')" : 'NULL'} AS requestedByName,
           r.requested_on AS requestedOn,
           r.admin_approved_at AS adminApprovedAt,
           r.finance_approved_at AS financeApprovedAt,
           r.management_approved_at AS managementApprovedAt,
           ${hasItems ? 'COALESCE(ri.itemCount, 0)' : 'NULL'} AS itemCount,
           ${hasItems ? 'COALESCE(ri.itemTotal, 0)' : 'NULL'} AS itemTotal,
           ${hasVouchers ? 'COALESCE(pv.voucherCount, 0)' : 'NULL'} AS voucherCount,
           ${hasVouchers ? 'COALESCE(pv.reservedTotal, 0)' : 'NULL'} AS reservedTotal,
           ${hasVouchers ? 'COALESCE(pv.paidTotal, 0)' : 'NULL'} AS paidTotal
    FROM requisitions r
    ${joins.join('\n    ')}
    ${whereSql(where)}
    ORDER BY r.requested_on DESC, r.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  const rows = await queryRows(sql, params);
  return withPagination({ rows }, limit, offset);
}

async function getRequisition(args) {
  const list = await listRequisitions({ requisitionId: args.requisitionId, limit: 1, offset: 0 });
  const requisition = list.rows[0] || null;
  if (!requisition) {
    return { requisition: null, items: [], vouchers: [], logs: [] };
  }

  const items = await loadRequisitionItems(args.requisitionId);
  const vouchers = await tableExists('payment_vouchers')
    ? (await listPaymentVouchers({ requisitionId: args.requisitionId, limit: MAX_LIMIT, offset: 0 })).rows
    : [];
  const logs = args.includeLogs ? await loadRequisitionLogs(args.requisitionId, args.logLimit) : [];

  return { requisition, items, vouchers, logs };
}

async function reviewRequisition(args) {
  await requireTable('requisitions');
  await requireTable('requisition_items');
  if (!args.dryRun && args.confirm !== true) {
    throw new Error('Set confirm to true to update a requisition approval.');
  }

  const conn = await pool.getConnection();
  try {
    const existing = await loadRequisitionApprovalState(conn, args.requisitionId);
    if (!existing) {
      throw new Error('Requisition not found.');
    }

    const currentStatus = String(existing.status || 'pending').toLowerCase();
    if (currentStatus === 'completed') {
      throw new Error('Completed requisitions cannot be reviewed.');
    }
    if (currentStatus === 'declined') {
      throw new Error('Declined requisitions cannot be reviewed.');
    }

    const proposed = await buildRequisitionReviewProposal(conn, existing, args);
    if (args.dryRun) {
      return {
        dryRun: true,
        current: existing,
        proposed,
      };
    }

    await conn.beginTransaction();
    try {
      await conn.execute(
        `UPDATE requisitions
         SET admin_approver_id = ?, admin_approved_at = ?,
             finance_approver_id = ?, finance_approved_at = ?,
             management_approver_id = ?, management_approved_at = ?,
             stage = ?, status = ?
         WHERE id = ?
         LIMIT 1`,
        [
          proposed.adminApproverId,
          proposed.adminApprovedAt,
          proposed.financeApproverId,
          proposed.financeApprovedAt,
          proposed.managementApproverId,
          proposed.managementApprovedAt,
          proposed.stage,
          proposed.status,
          args.requisitionId,
        ]
      );
      if (await tableExists('requisition_logs')) {
        await conn.execute(
          'INSERT INTO requisition_logs (requisition_id, action, actor_id) VALUES (?, ?, ?)',
          [args.requisitionId, proposed.logAction, args.actorId]
        );
      }
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    }
  } finally {
    conn.release();
  }

  const detail = await getRequisition({ requisitionId: args.requisitionId, includeLogs: true, logLimit: 10 });
  return {
    action: 'review_requisition',
    decision: args.decision,
    stage: args.stage,
    requisition: detail.requisition,
    items: detail.items,
    vouchers: detail.vouchers,
    logs: detail.logs,
  };
}

async function deleteRequisition(args) {
  await requireTable('requisitions');
  if (!args.dryRun && args.confirm !== true) {
    throw new Error('Set confirm to true to delete a requisition.');
  }

  let plan = null;
  const conn = await pool.getConnection();
  try {
    const detail = await getRequisition({ requisitionId: args.requisitionId, includeLogs: true, logLimit: MAX_LIMIT });
    if (!detail.requisition) {
      throw new Error('Requisition not found.');
    }
    plan = await buildRequisitionDeletePlan(conn, detail, args);
    if (args.dryRun) {
      return {
        dryRun: true,
        current: detail,
        proposed: plan,
      };
    }

    await conn.beginTransaction();
    try {
      await deleteRowsByColumn(conn, 'requisition_logs', 'requisition_id', args.requisitionId);
      await deleteRowsByColumn(conn, 'requisition_items', 'requisition_id', args.requisitionId);
      const [result] = await conn.execute(
        'DELETE FROM requisitions WHERE id = ? LIMIT 1',
        [args.requisitionId]
      );
      if (!result || result.affectedRows <= 0) {
        throw new Error('Failed to delete requisition.');
      }
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    }
  } finally {
    conn.release();
  }

  return {
    action: 'delete_requisition',
    requisitionId: args.requisitionId,
    actorId: args.actorId,
    reason: args.reason || null,
    deleted: plan,
  };
}

async function buildRequisitionDeletePlan(conn, detail, args) {
  const requisition = detail.requisition;
  const status = String(requisition.status || '').toLowerCase();
  if (['approved', 'completed'].includes(status)) {
    throw new Error('Approved or completed requisitions cannot be deleted.');
  }
  if (emptyToNull(requisition.managementApprovedAt)) {
    throw new Error('Management-approved requisitions cannot be deleted.');
  }
  const voucherRows = await tableExists('payment_vouchers')
    ? await connectionRows(
      conn,
      'SELECT id AS voucherId, status, total_spent AS totalSpent FROM payment_vouchers WHERE requisition_id = ? ORDER BY id ASC',
      [args.requisitionId]
    )
    : [];
  if (voucherRows.length > 0) {
    throw new Error('Delete linked payment vouchers before deleting this requisition.');
  }

  return {
    requisitionId: args.requisitionId,
    status,
    itemCount: detail.items.length,
    logCount: detail.logs.length,
    voucherCount: voucherRows.length,
    tables: [
      { table: 'requisition_logs', rows: detail.logs.length },
      { table: 'requisition_items', rows: detail.items.length },
      { table: 'requisitions', rows: 1 },
    ],
  };
}

async function loadRequisitionApprovalState(conn, requisitionId) {
  const rows = await connectionRows(
    conn,
    `SELECT id AS requisitionId,
            title,
            status,
            stage,
            admin_approver_id AS adminApproverId,
            admin_approved_at AS adminApprovedAt,
            finance_approver_id AS financeApproverId,
            finance_approved_at AS financeApprovedAt,
            management_approver_id AS managementApproverId,
            management_approved_at AS managementApprovedAt
     FROM requisitions
     WHERE id = ?
     LIMIT 1`,
    [requisitionId]
  );
  return rows[0] || null;
}

async function buildRequisitionReviewProposal(conn, existing, args) {
  const stage = args.stage;
  const decision = args.decision;
  let adminApproverId = nullableInt(existing.adminApproverId);
  let adminApprovedAt = emptyToNull(existing.adminApprovedAt);
  let financeApproverId = nullableInt(existing.financeApproverId);
  let financeApprovedAt = emptyToNull(existing.financeApprovedAt);
  let managementApproverId = nullableInt(existing.managementApproverId);
  let managementApprovedAt = emptyToNull(existing.managementApprovedAt);

  if (stage === 'finance' && !adminApprovedAt) {
    throw new Error('Admin approval is required before finance approval.');
  }
  if (stage === 'management' && !financeApprovedAt) {
    throw new Error('Finance approval is required before management approval.');
  }
  if (stage === 'admin' && decision === 'approve') {
    const budgetLinkStats = await requisitionBudgetLinkStatsOnConnection(conn, args.requisitionId);
    if (budgetLinkStats.total <= 0) {
      throw new Error('Admin approval requires at least one requisition item with a linked budget item.');
    }
    if (budgetLinkStats.missing > 0) {
      throw new Error('Admin approval requires linked budget items on all requisition line items.');
    }
  }
  if (decision === 'decline') {
    if (stage === 'admin' && adminApprovedAt) {
      throw new Error('Admin approval is already completed and cannot be declined.');
    }
    if (stage === 'finance' && financeApprovedAt) {
      throw new Error('Finance approval is already completed and cannot be declined.');
    }
    if (stage === 'management' && managementApprovedAt) {
      throw new Error('Management approval is already completed and cannot be declined.');
    }
  }
  if (decision === 'approve') {
    if (stage === 'admin' && adminApprovedAt) {
      throw new Error('Admin approval is already completed.');
    }
    if (stage === 'finance' && financeApprovedAt) {
      throw new Error('Finance approval is already completed.');
    }
    if (stage === 'management' && managementApprovedAt) {
      throw new Error('Management approval is already completed.');
    }
  }

  const now = await databaseNow(conn);
  if (stage === 'admin') {
    if (decision === 'approve') {
      adminApproverId = args.actorId;
      adminApprovedAt = now;
    } else {
      adminApproverId = null;
      adminApprovedAt = null;
      financeApproverId = null;
      financeApprovedAt = null;
      managementApproverId = null;
      managementApprovedAt = null;
    }
  } else if (stage === 'finance') {
    if (decision === 'approve') {
      financeApproverId = args.actorId;
      financeApprovedAt = now;
    } else {
      financeApproverId = null;
      financeApprovedAt = null;
      managementApproverId = null;
      managementApprovedAt = null;
    }
  } else if (decision === 'approve') {
    managementApproverId = args.actorId;
    managementApprovedAt = now;
  } else {
    managementApproverId = null;
    managementApprovedAt = null;
  }

  let status = 'pending';
  if (decision === 'decline') {
    status = 'declined';
  } else if (String(existing.status || '').toLowerCase() === 'completed') {
    status = 'completed';
  } else if (stage === 'management') {
    status = 'approved';
  }

  const logAction = truncateText(
    `${capitalize(stage)} ${decision === 'approve' ? 'approved' : 'declined'}${args.reason ? ` - ${args.reason}` : ''}`,
    200
  );

  return {
    adminApproverId,
    adminApprovedAt,
    financeApproverId,
    financeApprovedAt,
    managementApproverId,
    managementApprovedAt,
    stage: computeRequisitionStage(adminApprovedAt, financeApprovedAt),
    status,
    logAction,
  };
}

async function requisitionBudgetLinkStatsOnConnection(conn, requisitionId) {
  const stats = { total: 0, linked: 0, missing: 0 };
  const hasBudgetEntries = await tableExists('monthly_budget_entry');
  const hasShipmentBudgetEntries = await tableExists('shipment_budget') && await tableExists('shipment_budget_item');
  const linkedConditions = [];
  if (hasBudgetEntries) {
    linkedConditions.push('(ri.shipment_id IS NULL OR ri.shipment_id = 0) AND mbe.id IS NOT NULL');
  }
  if (hasShipmentBudgetEntries) {
    linkedConditions.push('ri.shipment_id IS NOT NULL AND ri.shipment_id > 0 AND sbi.id IS NOT NULL');
  }
  const linkedConditionSql = linkedConditions.length > 0 ? `(${linkedConditions.join(' OR ')})` : '0 = 1';
  const joins = [];
  if (hasBudgetEntries) {
    joins.push(`LEFT JOIN monthly_budget_entry mbe
      ON mbe.id = ri.budget_item_id
     AND (ri.shipment_id IS NULL OR ri.shipment_id = 0)`);
  }
  if (hasShipmentBudgetEntries) {
    joins.push(`LEFT JOIN shipment_budget_item sbi
      ON sbi.id = ri.budget_item_id
     AND ri.shipment_id IS NOT NULL
     AND ri.shipment_id > 0
     AND EXISTS (
       SELECT 1
       FROM shipment_budget sb
       WHERE sb.id = sbi.budget_id
         AND sb.shipmentid = ri.shipment_id
     )`);
  }
  const rows = await connectionRows(
    conn,
    `SELECT COUNT(*) AS totalItems,
            COALESCE(SUM(CASE
              WHEN ri.budget_item_id IS NOT NULL
               AND ri.budget_item_id > 0
               AND ${linkedConditionSql}
              THEN 1 ELSE 0 END), 0) AS linkedItems
     FROM requisition_items ri
     ${joins.join('\n     ')}
     WHERE ri.requisition_id = ?`,
    [requisitionId]
  );
  const row = rows[0] || {};
  stats.total = Number(row.totalItems || 0);
  stats.linked = Number(row.linkedItems || 0);
  stats.missing = Math.max(stats.total - stats.linked, 0);
  return stats;
}

function computeRequisitionStage(adminApprovedAt, financeApprovedAt) {
  if (!adminApprovedAt) {
    return 'admin';
  }
  if (!financeApprovedAt) {
    return 'finance';
  }
  return 'management';
}

async function listPaymentVouchers(args) {
  await requireTable('payment_vouchers');
  const hasRequisitions = await tableExists('requisitions');
  const hasItems = await tableExists('payment_voucher_items');
  const hasProofs = await tableExists('payment_voucher_proofs');
  const hasBudgetPosted = await hasColumn('payment_vouchers', 'budget_posted_at');
  const hasPaymentReference = await hasColumn('payment_vouchers', 'payment_reference');
  const hasAllocatedAmount = hasItems && await hasColumn('payment_voucher_items', 'allocated_amount');

  const joins = [];
  if (hasRequisitions) {
    joins.push('LEFT JOIN `requisitions` r ON r.`id` = pv.`requisition_id`');
  }
  if (hasItems) {
    joins.push(
      `LEFT JOIN (
        SELECT voucher_id,
               COUNT(*) AS itemCount,
               COALESCE(SUM(quantity * unit_price), 0) AS itemTotal,
               ${hasAllocatedAmount ? 'COALESCE(SUM(COALESCE(allocated_amount, quantity * unit_price)), 0)' : 'COALESCE(SUM(quantity * unit_price), 0)'} AS allocatedTotal
        FROM payment_voucher_items
        GROUP BY voucher_id
      ) pvi ON pvi.voucher_id = pv.id`
    );
  }
  if (hasProofs) {
    joins.push(
      `LEFT JOIN (
        SELECT voucher_id,
               COUNT(*) AS proofCount,
               MAX(uploaded_at) AS latestProofAt
        FROM payment_voucher_proofs
        GROUP BY voucher_id
      ) proofs ON proofs.voucher_id = pv.id`
    );
  }

  const where = [];
  const params = [];
  addEqual(where, params, 'pv.`id`', args.voucherId);
  addEqual(where, params, 'pv.`requisition_id`', args.requisitionId);
  addLike(where, params, 'pv.`status`', args.status);
  addLike(where, params, 'pv.`payment_method`', args.paymentMethod);
  if (args.initiatedFrom) {
    where.push('pv.`initiated_at` >= ?');
    params.push(args.initiatedFrom);
  }
  if (args.initiatedTo) {
    where.push('pv.`initiated_at` < DATE_ADD(?, INTERVAL 1 DAY)');
    params.push(args.initiatedTo);
  }
  if (args.search) {
    const parts = [
      'pv.`recipient_name` LIKE ?',
      'pv.`recipient_contact` LIKE ?',
      'pv.`notes` LIKE ?',
    ];
    params.push(like(args.search), like(args.search), like(args.search));
    if (hasPaymentReference) {
      parts.push('pv.`payment_reference` LIKE ?');
      params.push(like(args.search));
    }
    if (hasRequisitions) {
      parts.push('r.`title` LIKE ?');
      params.push(like(args.search));
    }
    where.push(`(${parts.join(' OR ')})`);
  }

  const { limit, offset } = pagination(args);
  const sql = `
    SELECT pv.id AS voucherId,
           pv.requisition_id AS requisitionId,
           ${hasRequisitions ? 'r.title' : 'NULL'} AS requisitionTitle,
           pv.recipient_name AS recipientName,
           pv.recipient_contact AS recipientContact,
           pv.payment_method AS paymentMethod,
           ${hasPaymentReference ? 'pv.payment_reference' : 'NULL'} AS paymentReference,
           pv.total_spent AS totalSpent,
           pv.status AS status,
           pv.reviewed_by AS reviewedBy,
           pv.reviewed_at AS reviewedAt,
           ${hasBudgetPosted ? 'pv.budget_posted_at' : 'NULL'} AS budgetPostedAt,
           pv.created_by AS createdBy,
           pv.updated_by AS updatedBy,
           pv.initiated_at AS initiatedAt,
           pv.updated_at AS updatedAt,
           ${hasItems ? 'COALESCE(pvi.itemCount, 0)' : 'NULL'} AS itemCount,
           ${hasItems ? 'COALESCE(pvi.itemTotal, 0)' : 'NULL'} AS itemTotal,
           ${hasItems ? 'COALESCE(pvi.allocatedTotal, 0)' : 'NULL'} AS allocatedTotal,
           ${hasProofs ? 'COALESCE(proofs.proofCount, 0)' : 'NULL'} AS proofCount,
           ${hasProofs ? 'proofs.latestProofAt' : 'NULL'} AS latestProofAt
    FROM payment_vouchers pv
    ${joins.join('\n    ')}
    ${whereSql(where)}
    ORDER BY pv.initiated_at DESC, pv.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  const rows = await queryRows(sql, params);
  return withPagination({ rows }, limit, offset);
}

async function getPaymentVoucher(args) {
  const list = await listPaymentVouchers({ voucherId: args.voucherId, limit: 1, offset: 0 });
  const voucher = list.rows[0] || null;
  if (!voucher) {
    return { voucher: null, items: [], proofs: [], requisition: null };
  }

  const items = await loadPaymentVoucherItems(args.voucherId);
  const proofs = await loadPaymentVoucherProofs(args.voucherId);
  const requisitionId = Number(voucher.requisitionId || 0);
  const requisition = requisitionId > 0
    ? (await listRequisitions({ requisitionId, limit: 1, offset: 0 })).rows[0] || null
    : null;

  return { voucher, items, proofs, requisition };
}

async function reviewPaymentVoucher(args) {
  await requireTable('payment_vouchers');
  if (!args.dryRun && args.confirm !== true) {
    throw new Error('Set confirm to true to update a payment voucher review.');
  }

  const conn = await pool.getConnection();
  try {
    const voucher = await loadPaymentVoucherState(conn, args.voucherId);
    if (!voucher) {
      throw new Error('Payment voucher not found.');
    }
    const currentStatus = normalizeVoucherStatus(voucher.status);
    if (currentStatus !== 'submitted') {
      throw new Error('Only submitted vouchers can be reviewed by management.');
    }

    const newStatus = args.decision === 'approve' ? 'approved' : 'declined';
    const reviewedAt = await databaseNow(conn);
    const proposed = {
      voucherId: args.voucherId,
      fromStatus: currentStatus,
      toStatus: newStatus,
      reviewedBy: args.actorId,
      reviewedAt,
      reason: args.reason || null,
    };
    if (args.dryRun) {
      return {
        dryRun: true,
        current: voucher,
        proposed,
      };
    }

    await conn.beginTransaction();
    try {
      const [result] = await conn.execute(
        `UPDATE payment_vouchers
         SET status = ?, reviewed_by = ?, reviewed_at = ?, updated_by = ?
         WHERE id = ? AND status = 'submitted'
         LIMIT 1`,
        [newStatus, args.actorId, reviewedAt, args.actorId, args.voucherId]
      );
      if (!result || result.affectedRows <= 0) {
        throw new Error('Failed to update payment voucher.');
      }
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    }
  } finally {
    conn.release();
  }

  const detail = await getPaymentVoucher({ voucherId: args.voucherId });
  return {
    action: 'review_payment_voucher',
    decision: args.decision,
    voucher: detail.voucher,
    items: detail.items,
    proofs: detail.proofs,
    requisition: detail.requisition,
  };
}

async function deletePaymentVoucher(args) {
  await requireTable('payment_vouchers');
  if (!args.dryRun && args.confirm !== true) {
    throw new Error('Set confirm to true to delete a payment voucher.');
  }

  let plan = null;
  const conn = await pool.getConnection();
  try {
    const detail = await getPaymentVoucher({ voucherId: args.voucherId });
    if (!detail.voucher) {
      throw new Error('Payment voucher not found.');
    }
    const voucher = await loadPaymentVoucherState(conn, args.voucherId);
    if (!voucher) {
      throw new Error('Payment voucher not found.');
    }
    plan = buildPaymentVoucherDeletePlan(detail, voucher);
    if (args.dryRun) {
      return {
        dryRun: true,
        current: detail,
        proposed: plan,
      };
    }

    await conn.beginTransaction();
    try {
      await deleteRowsByColumn(conn, 'payment_voucher_proofs', 'voucher_id', args.voucherId);
      await deleteRowsByColumn(conn, 'payment_voucher_items', 'voucher_id', args.voucherId);
      const [result] = await conn.execute(
        'DELETE FROM payment_vouchers WHERE id = ? LIMIT 1',
        [args.voucherId]
      );
      if (!result || result.affectedRows <= 0) {
        throw new Error('Failed to delete payment voucher.');
      }
      const requisitionId = Number(voucher.requisitionId || 0);
      if (requisitionId > 0) {
        await refreshRequisitionStatusFromVouchersOnConnection(conn, requisitionId);
      }
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    }
  } finally {
    conn.release();
  }

  return {
    action: 'delete_payment_voucher',
    voucherId: args.voucherId,
    actorId: args.actorId,
    reason: args.reason || null,
    deleted: plan,
  };
}

function buildPaymentVoucherDeletePlan(detail, voucher) {
  const status = normalizeVoucherStatus(voucher.status);
  if (!['submitted', 'declined'].includes(status)) {
    throw new Error('Only submitted or declined payment vouchers can be deleted.');
  }
  if (emptyToNull(voucher.budgetPostedAt)) {
    throw new Error('Budget-posted payment vouchers cannot be deleted.');
  }

  return {
    voucherId: voucher.voucherId,
    requisitionId: voucher.requisitionId,
    status,
    itemCount: detail.items.length,
    proofCount: detail.proofs.length,
    tables: [
      { table: 'payment_voucher_proofs', rows: detail.proofs.length },
      { table: 'payment_voucher_items', rows: detail.items.length },
      { table: 'payment_vouchers', rows: 1 },
    ],
  };
}

async function markPaymentVoucherPaid(args) {
  await requireTable('payment_vouchers');
  if (!args.dryRun && args.confirm !== true) {
    throw new Error('Set confirm to true to mark a payment voucher paid.');
  }

  const conn = await pool.getConnection();
  let budgetPostSummary = null;
  try {
    const voucher = await loadPaymentVoucherState(conn, args.voucherId);
    if (!voucher) {
      throw new Error('Payment voucher not found.');
    }
    const currentStatus = normalizeVoucherStatus(voucher.status);
    if (currentStatus === 'paid') {
      throw new Error('This voucher is already marked as paid.');
    }
    if (currentStatus !== 'approved') {
      throw new Error('Only management-approved vouchers can be marked as paid.');
    }
    const alreadyPosted = Boolean(emptyToNull(voucher.budgetPostedAt));
    const spendPreview = alreadyPosted
      ? { alreadyPosted: true, monthlyTotals: [], shipmentTotals: [] }
      : await buildVoucherBudgetSpendPlan(conn, args.voucherId);
    const proposed = {
      voucherId: args.voucherId,
      fromStatus: currentStatus,
      toStatus: 'paid',
      updatedBy: args.actorId,
      willPostBudgetSpend: !alreadyPosted,
      spendPreview,
    };
    if (args.dryRun) {
      return {
        dryRun: true,
        current: voucher,
        proposed,
      };
    }

    await conn.beginTransaction();
    try {
      if (!alreadyPosted) {
        budgetPostSummary = await applyVoucherBudgetSpend(conn, args.voucherId, spendPreview);
      } else {
        budgetPostSummary = { alreadyPosted: true, monthlyPosted: [], shipmentPosted: [] };
      }

      const [result] = await conn.execute(
        `UPDATE payment_vouchers
         SET status = 'paid', updated_by = ?, budget_posted_at = COALESCE(budget_posted_at, NOW())
         WHERE id = ? AND status = 'approved'
         LIMIT 1`,
        [args.actorId, args.voucherId]
      );
      if (!result || result.affectedRows <= 0) {
        throw new Error('Failed to update payment voucher.');
      }
      const requisitionId = Number(voucher.requisitionId || 0);
      if (requisitionId > 0) {
        await refreshRequisitionStatusFromVouchersOnConnection(conn, requisitionId);
      }
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    }
  } finally {
    conn.release();
  }

  const detail = await getPaymentVoucher({ voucherId: args.voucherId });
  return {
    action: 'mark_payment_voucher_paid',
    budgetPostSummary,
    voucher: detail.voucher,
    items: detail.items,
    proofs: detail.proofs,
    requisition: detail.requisition,
  };
}

async function loadPaymentVoucherState(conn, voucherId) {
  const rows = await connectionRows(
    conn,
    `SELECT id AS voucherId,
            requisition_id AS requisitionId,
            recipient_name AS recipientName,
            total_spent AS totalSpent,
            status,
            reviewed_by AS reviewedBy,
            reviewed_at AS reviewedAt,
            budget_posted_at AS budgetPostedAt,
            created_by AS createdBy,
            updated_by AS updatedBy,
            initiated_at AS initiatedAt,
            updated_at AS updatedAt
     FROM payment_vouchers
     WHERE id = ?
     LIMIT 1`,
    [voucherId]
  );
  return rows[0] || null;
}

async function buildVoucherBudgetSpendPlan(conn, voucherId) {
  await requireTable('payment_voucher_items');
  const hasBudgetItemId = await hasColumn('payment_voucher_items', 'budget_item_id');
  const hasShipmentId = await hasColumn('payment_voucher_items', 'shipment_id');
  const hasAllocatedAmount = await hasColumn('payment_voucher_items', 'allocated_amount');
  if (!hasBudgetItemId || !hasShipmentId) {
    throw new Error('Payment voucher item allocation columns are not available.');
  }

  const rows = await connectionRows(
    conn,
    `SELECT budget_item_id AS budgetItemId,
            shipment_id AS shipmentId,
            ${hasAllocatedAmount ? 'allocated_amount' : 'NULL'} AS allocatedAmount,
            quantity,
            unit_price AS unitPrice
     FROM payment_voucher_items
     WHERE voucher_id = ?
     ORDER BY id ASC`,
    [voucherId]
  );
  if (rows.length === 0) {
    throw new Error('Payment voucher has no items to post.');
  }

  const monthlyMap = new Map();
  const shipmentMap = new Map();
  for (const row of rows) {
    const amount = voucherItemAllocatedAmount(row);
    if (amount <= 0) {
      continue;
    }
    const budgetItemId = Number(row.budgetItemId || 0);
    if (budgetItemId <= 0) {
      throw new Error('Payment voucher has item spend without an allocated budget item.');
    }
    const shipmentId = Number(row.shipmentId || 0);
    if (shipmentId > 0) {
      const key = `${shipmentId}:${budgetItemId}`;
      const current = shipmentMap.get(key) || { shipmentId, budgetItemId, amount: 0 };
      current.amount = roundMoney(current.amount + amount);
      shipmentMap.set(key, current);
    } else {
      monthlyMap.set(budgetItemId, roundMoney((monthlyMap.get(budgetItemId) || 0) + amount));
    }
  }

  const monthlyTotals = [...monthlyMap.entries()].map(([budgetItemId, amount]) => ({ budgetItemId, amount }));
  const shipmentTotals = [...shipmentMap.values()];
  if (monthlyTotals.length === 0 && shipmentTotals.length === 0) {
    throw new Error('Payment voucher has no allocated amount to post.');
  }
  if (monthlyTotals.length > 0 && !await tableExists('monthly_budget_entry')) {
    throw new Error('Monthly budget entries are not available.');
  }
  if (shipmentTotals.length > 0 && (!await tableExists('shipment_budget') || !await tableExists('shipment_budget_item'))) {
    throw new Error('Shipment budget items are not available.');
  }

  return {
    alreadyPosted: false,
    monthlyTotals,
    shipmentTotals,
  };
}

async function applyVoucherBudgetSpend(conn, voucherId, plan = null) {
  const spendPlan = plan || await buildVoucherBudgetSpendPlan(conn, voucherId);
  const monthlyPosted = [];
  const shipmentPosted = [];

  for (const entry of spendPlan.monthlyTotals || []) {
    const [result] = await conn.execute(
      `UPDATE monthly_budget_entry
       SET spent_amount = COALESCE(spent_amount, 0) + ?
       WHERE id = ?
       LIMIT 1`,
      [entry.amount, entry.budgetItemId]
    );
    if (!result || result.affectedRows <= 0) {
      throw new Error('A linked monthly budget item could not be updated.');
    }
    monthlyPosted.push(entry);
  }

  for (const entry of spendPlan.shipmentTotals || []) {
    const [result] = await conn.execute(
      `UPDATE shipment_budget_item sbi
       INNER JOIN shipment_budget sb ON sb.id = sbi.budget_id
       SET sbi.spent_amount = COALESCE(sbi.spent_amount, 0) + ?
       WHERE sbi.id = ? AND sb.shipmentid = ?
       LIMIT 1`,
      [entry.amount, entry.budgetItemId, entry.shipmentId]
    );
    if (!result || result.affectedRows <= 0) {
      throw new Error('A linked shipment budget item could not be updated.');
    }
    shipmentPosted.push(entry);
  }

  return {
    alreadyPosted: false,
    monthlyPosted,
    shipmentPosted,
  };
}

async function refreshRequisitionStatusFromVouchersOnConnection(conn, requisitionId) {
  if (!await tableExists('requisitions')) {
    return null;
  }
  const rows = await connectionRows(
    conn,
    'SELECT status, total_amount AS totalAmount FROM requisitions WHERE id = ? LIMIT 1',
    [requisitionId]
  );
  const row = rows[0] || null;
  if (!row) {
    return null;
  }
  const currentStatus = String(row.status || '').toLowerCase();
  if (['declined', 'completed'].includes(currentStatus)) {
    return currentStatus;
  }
  let totalAmount = Number(row.totalAmount || 0);
  if (totalAmount <= 0 && await tableExists('requisition_items')) {
    const sumRows = await connectionRows(
      conn,
      'SELECT COALESCE(SUM(quantity * unit_price), 0) AS totalAmount FROM requisition_items WHERE requisition_id = ?',
      [requisitionId]
    );
    totalAmount = Number(sumRows[0]?.totalAmount || 0);
  }
  if (totalAmount <= 0) {
    return currentStatus;
  }
  const paidTotal = await loadRequisitionTotalSpentOnConnection(conn, requisitionId, false);
  if ((totalAmount - paidTotal) <= 0.01) {
    await conn.execute('UPDATE requisitions SET status = ? WHERE id = ? LIMIT 1', ['completed', requisitionId]);
    return 'completed';
  }
  return currentStatus;
}

async function loadRequisitionTotalSpentOnConnection(conn, requisitionId, includeSubmitted = true, excludeVoucherId = 0) {
  if (!await tableExists('payment_vouchers')) {
    return 0;
  }
  const statusFilter = includeSubmitted
    ? "COALESCE(pv.status, 'submitted') IN ('submitted','approved','paid','purchased')"
    : "COALESCE(pv.status, 'submitted') IN ('paid','purchased')";
  const params = [requisitionId];
  let excludeSql = '';
  if (excludeVoucherId > 0) {
    excludeSql = ' AND pv.id <> ?';
    params.push(excludeVoucherId);
  }
  const rows = await connectionRows(
    conn,
    `SELECT COALESCE(SUM(COALESCE(pv.total_spent, totals.totalAmount, 0)), 0) AS totalSpent
     FROM payment_vouchers pv
     LEFT JOIN (
       SELECT voucher_id, SUM(quantity * unit_price) AS totalAmount
       FROM payment_voucher_items
       GROUP BY voucher_id
     ) totals ON totals.voucher_id = pv.id
     WHERE pv.requisition_id = ? AND ${statusFilter}${excludeSql}`,
    params
  );
  return Number(rows[0]?.totalSpent || 0);
}

function normalizeVoucherStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  return normalized === 'purchased' ? 'paid' : normalized;
}

function voucherItemAllocatedAmount(row) {
  const allocated = row.allocatedAmount;
  if (allocated !== null && allocated !== undefined && allocated !== '' && Number.isFinite(Number(allocated))) {
    return roundMoney(Number(allocated));
  }
  return roundMoney(Number(row.quantity || 0) * Number(row.unitPrice || 0));
}

async function listClientProfileReports(args) {
  const clientsTable = await resolveTable(['Clients', 'clients']);
  if (!clientsTable) {
    throw new Error("Required table 'Clients' was not found in the configured database.");
  }

  const clientIdCol = await pickColumn(clientsTable, ['userid', 'id', 'client_id']);
  if (!clientIdCol) {
    throw new Error(`No client id column was found in '${clientsTable}'.`);
  }

  const hasCargo = await tableExists('cargo');
  const hasLeads = await tableExists('client_leads');
  const orderInfo = await resolveOrderFormInfo(false);
  const hasEmployee = await tableExists('employee');
  const columns = {
    first: await pickColumn(clientsTable, ['firstname', 'first_name']),
    last: await pickColumn(clientsTable, ['lastname', 'last_name']),
    email: await pickColumn(clientsTable, ['email']),
    phone: await pickColumn(clientsTable, ['phonenumber', 'phone']),
    gender: await pickColumn(clientsTable, ['gender']),
    clientType: await pickColumn(clientsTable, ['client_type']),
    business: await pickColumn(clientsTable, ['business', 'company_name']),
    businessCategory: await pickColumn(clientsTable, ['businesscategory', 'business_category']),
    location: await pickColumn(clientsTable, ['Location', 'location']),
    tier: await pickColumn(clientsTable, ['category', 'tier']),
    shipmentCount: await pickColumn(clientsTable, ['shipmentcount', 'shipment_count']),
    lastShipment: await pickColumn(clientsTable, ['lastshipment', 'last_shipment']),
    createdOn: await pickColumn(clientsTable, ['createdon', 'created_at', 'created']),
    relationEmployeeId: await pickColumn(clientsTable, ['relation_employee_id']),
  };

  const cargoWhere = [];
  const cargoParams = [];
  if (args.activeFrom) {
    cargoWhere.push('cg.`cargocreatedon` >= ?');
    cargoParams.push(args.activeFrom);
  }
  if (args.activeTo) {
    cargoWhere.push('cg.`cargocreatedon` < DATE_ADD(?, INTERVAL 1 DAY)');
    cargoParams.push(args.activeTo);
  }

  const joins = [];
  if (hasCargo) {
    joins.push(
      `LEFT JOIN (
        SELECT cg.\`userid\` AS clientId,
               COUNT(*) AS cargoCount,
               COALESCE(SUM(cg.\`weight\`), 0) AS totalWeight,
               COALESCE(SUM(cg.\`volume\`), 0) AS totalVolume,
               COALESCE(SUM(cg.\`packages\`), 0) AS declaredPackages,
               MIN(cg.\`cargocreatedon\`) AS firstCargoAt,
               MAX(cg.\`cargocreatedon\`) AS lastCargoAt
        FROM cargo cg
        ${whereSql(cargoWhere)}
        GROUP BY cg.\`userid\`
      ) cargo ON cargo.clientId = cl.${qid(clientIdCol)}`
    );
  }
  if (hasLeads) {
    joins.push(
      `LEFT JOIN (
        SELECT LOWER(TRIM(lead_phone)) AS leadKey,
               COUNT(*) AS leadCount,
               COALESCE(SUM(CASE WHEN LOWER(COALESCE(lead_status, '')) LIKE '%convert%' THEN 1 ELSE 0 END), 0) AS convertedLeadCount,
               MAX(created_on) AS latestLeadAt
        FROM client_leads
        WHERE TRIM(COALESCE(lead_phone, '')) <> ''
        GROUP BY LOWER(TRIM(lead_phone))
      ) leads_phone ON ${columns.phone ? `leads_phone.leadKey = LOWER(TRIM(cl.${qid(columns.phone)}))` : '1 = 0'}`
    );
    joins.push(
      `LEFT JOIN (
        SELECT LOWER(TRIM(lead_email)) AS leadKey,
               COUNT(*) AS leadCount,
               COALESCE(SUM(CASE WHEN LOWER(COALESCE(lead_status, '')) LIKE '%convert%' THEN 1 ELSE 0 END), 0) AS convertedLeadCount,
               MAX(created_on) AS latestLeadAt
        FROM client_leads
        WHERE TRIM(COALESCE(lead_email, '')) <> ''
        GROUP BY LOWER(TRIM(lead_email))
      ) leads_email ON ${columns.email ? `leads_email.leadKey = LOWER(TRIM(cl.${qid(columns.email)}))` : '1 = 0'}`
    );
  }
  if (orderInfo?.table && orderInfo.columns.clientId) {
    joins.push(
      `LEFT JOIN (
        SELECT ${qid(orderInfo.columns.clientId)} AS clientId,
               COUNT(*) AS orderCount,
               COALESCE(SUM(${orderInfo.columns.total ? qid(orderInfo.columns.total) : '0'}), 0) AS orderValue,
               MAX(${orderInfo.columns.created ? qid(orderInfo.columns.created) : qid(orderInfo.columns.id)}) AS latestOrderAt
        FROM ${qid(orderInfo.table)}
        GROUP BY ${qid(orderInfo.columns.clientId)}
      ) orders ON orders.clientId = cl.${qid(clientIdCol)}`
    );
  }
  if (hasEmployee && columns.relationEmployeeId) {
    joins.push(`LEFT JOIN employee rel ON rel.employeeid = cl.${qid(columns.relationEmployeeId)}`);
  }

  const where = [];
  const params = [];
  addEqual(where, params, `cl.${qid(clientIdCol)}`, args.clientId);
  if (columns.clientType) addLike(where, params, `cl.${qid(columns.clientType)}`, args.clientType);
  if (columns.gender) addLike(where, params, `cl.${qid(columns.gender)}`, args.gender);
  if (columns.tier) addLike(where, params, `cl.${qid(columns.tier)}`, args.tier);
  if (columns.relationEmployeeId) addEqual(where, params, `cl.${qid(columns.relationEmployeeId)}`, args.relationEmployeeId);
  if (columns.createdOn && args.createdFrom) {
    where.push(`cl.${qid(columns.createdOn)} >= ?`);
    params.push(args.createdFrom);
  }
  if (columns.createdOn && args.createdTo) {
    where.push(`cl.${qid(columns.createdOn)} < DATE_ADD(?, INTERVAL 1 DAY)`);
    params.push(args.createdTo);
  }
  if (args.onlyWithCargoActivity) {
    where.push(hasCargo ? 'COALESCE(cargo.cargoCount, 0) > 0' : '1 = 0');
  }
  if (args.search) {
    const searchParts = [];
    for (const column of [columns.first, columns.last, columns.email, columns.phone, columns.business, columns.businessCategory, columns.location]) {
      if (column) {
        searchParts.push(`cl.${qid(column)} LIKE ?`);
        params.push(like(args.search));
      }
    }
    if (searchParts.length > 0) {
      where.push(`(${searchParts.join(' OR ')})`);
    }
  }

  const { limit, offset } = pagination(args);
  const select = [
    `cl.${qid(clientIdCol)} AS clientId`,
    `${clientNameExpression('cl', columns.first, columns.last, columns.business)} AS clientName`,
    `${columnExpression('cl', columns.business)} AS business`,
    `${columnExpression('cl', columns.businessCategory)} AS businessCategory`,
    `${columnExpression('cl', columns.email)} AS email`,
    `${columnExpression('cl', columns.phone)} AS phone`,
    `${columnExpression('cl', columns.gender)} AS gender`,
    `${columnExpression('cl', columns.clientType)} AS clientType`,
    `${columnExpression('cl', columns.location)} AS location`,
    `${columnExpression('cl', columns.tier)} AS tier`,
    `${columnExpression('cl', columns.shipmentCount)} AS recordedShipmentCount`,
    `${columnExpression('cl', columns.lastShipment)} AS recordedLastShipment`,
    `${columnExpression('cl', columns.relationEmployeeId)} AS relationEmployeeId`,
    hasEmployee && columns.relationEmployeeId ? `${employeeNameExpression('rel')} AS relationEmployeeName` : 'NULL AS relationEmployeeName',
    `${columnExpression('cl', columns.createdOn)} AS createdOn`,
    hasCargo ? 'COALESCE(cargo.cargoCount, 0) AS cargoCount' : 'NULL AS cargoCount',
    hasCargo ? 'COALESCE(cargo.totalWeight, 0) AS totalWeight' : 'NULL AS totalWeight',
    hasCargo ? 'COALESCE(cargo.totalVolume, 0) AS totalVolume' : 'NULL AS totalVolume',
    hasCargo ? 'COALESCE(cargo.declaredPackages, 0) AS declaredPackages' : 'NULL AS declaredPackages',
    hasCargo ? 'cargo.firstCargoAt AS firstCargoAt' : 'NULL AS firstCargoAt',
    hasCargo ? 'cargo.lastCargoAt AS lastCargoAt' : 'NULL AS lastCargoAt',
    hasLeads ? '(COALESCE(leads_phone.leadCount, 0) + COALESCE(leads_email.leadCount, 0)) AS leadCount' : 'NULL AS leadCount',
    hasLeads ? '(COALESCE(leads_phone.convertedLeadCount, 0) + COALESCE(leads_email.convertedLeadCount, 0)) AS convertedLeadCount' : 'NULL AS convertedLeadCount',
    hasLeads ? `CASE
      WHEN leads_phone.latestLeadAt IS NULL THEN leads_email.latestLeadAt
      WHEN leads_email.latestLeadAt IS NULL THEN leads_phone.latestLeadAt
      ELSE GREATEST(leads_phone.latestLeadAt, leads_email.latestLeadAt)
    END AS latestLeadAt` : 'NULL AS latestLeadAt',
    orderInfo?.table && orderInfo.columns.clientId ? 'COALESCE(orders.orderCount, 0) AS orderCount' : 'NULL AS orderCount',
    orderInfo?.table && orderInfo.columns.clientId ? 'COALESCE(orders.orderValue, 0) AS orderValue' : 'NULL AS orderValue',
    orderInfo?.table && orderInfo.columns.clientId ? 'orders.latestOrderAt AS latestOrderAt' : 'NULL AS latestOrderAt',
  ];

  const sql = `
    SELECT ${select.join(',\n           ')}
    FROM ${qid(clientsTable)} cl
    ${joins.join('\n    ')}
    ${whereSql(where)}
    ORDER BY COALESCE(${hasCargo ? 'cargo.lastCargoAt' : 'NULL'}, ${columns.createdOn ? `cl.${qid(columns.createdOn)}` : 'NULL'}) DESC,
             cl.${qid(clientIdCol)} DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  const rows = await queryRows(sql, [...cargoParams, ...params]);
  return withPagination({ rows }, limit, offset);
}

async function getClientProfileReport(args) {
  const list = await listClientProfileReports({ clientId: args.clientId, limit: 1, offset: 0 });
  const client = list.rows[0] || null;
  if (!client) {
    return { client: null, cargo: [], leads: [], orderForms: [] };
  }

  const limit = clampInt(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const cargo = args.includeCargo && await tableExists('cargo')
    ? (await listCargo({ clientId: args.clientId, limit, offset: 0 })).rows
    : [];
  const leads = args.includeLeads
    ? await loadClientMatchedLeads(client, limit)
    : [];
  const orderForms = args.includeOrders && await tableExists('order_forms')
    ? (await listOrderFormReports({ clientId: args.clientId, limit, offset: 0, includeSummary: false })).rows
    : [];

  return { client, cargo, leads, orderForms };
}

async function listLeadReports(args) {
  await requireTable('client_leads');
  const hasEmployee = await tableExists('employee');
  const hasPortfolios = await tableExists('client_lead_portfolios');

  const where = [];
  const params = [];
  addEqual(where, params, 'l.`id`', args.leadId);
  addLike(where, params, 'l.`lead_status`', args.status);
  addLike(where, params, 'l.`permission_status`', args.permissionStatus);
  addLike(where, params, 'l.`district`', args.district);
  addEqual(where, params, 'l.`relation_employee_id`', args.ownerId);
  addEqual(where, params, 'l.`procurement_employee_id`', args.procurementEmployeeId);
  addEqual(where, params, 'l.`portfolio_id`', args.portfolioId);
  addEqual(where, params, 'l.`created_by`', args.createdBy);
  if (args.createdFrom) {
    where.push('l.`created_on` >= ?');
    params.push(args.createdFrom);
  }
  if (args.createdTo) {
    where.push('l.`created_on` < DATE_ADD(?, INTERVAL 1 DAY)');
    params.push(args.createdTo);
  }
  if (args.search) {
    where.push(`(
      l.\`lead_name\` LIKE ?
      OR l.\`lead_phone\` LIKE ?
      OR l.\`lead_email\` LIKE ?
      OR l.\`referrer_name\` LIKE ?
      OR l.\`service_interest\` LIKE ?
      OR l.\`district\` LIKE ?
      OR l.\`notes\` LIKE ?
    )`);
    params.push(
      like(args.search),
      like(args.search),
      like(args.search),
      like(args.search),
      like(args.search),
      like(args.search),
      like(args.search)
    );
  }

  const joins = [];
  if (hasEmployee) {
    joins.push('LEFT JOIN employee er ON er.employeeid = l.relation_employee_id');
    joins.push('LEFT JOIN employee ep ON ep.employeeid = l.procurement_employee_id');
    joins.push('LEFT JOIN employee ec ON ec.employeeid = l.created_by');
  }
  if (hasPortfolios) {
    joins.push('LEFT JOIN client_lead_portfolios p ON p.id = l.portfolio_id');
  }

  const { limit, offset } = pagination(args);
  const sql = `
    SELECT l.id AS leadId,
           l.referrer_name AS referrerName,
           l.referrer_email AS referrerEmail,
           l.lead_name AS leadName,
           l.lead_phone AS leadPhone,
           l.lead_email AS leadEmail,
           ${await hasColumn('client_leads', 'lead_gender') ? 'l.lead_gender' : 'NULL'} AS leadGender,
           l.district,
           l.service_interest AS serviceInterest,
           ${await hasColumn('client_leads', 'interest_categories') ? 'l.interest_categories' : 'NULL'} AS interestCategories,
           l.relationship_to_referrer AS relationshipToReferrer,
           l.permission_status AS permissionStatus,
           l.lead_status AS leadStatus,
           ${await hasColumn('client_leads', 'cbm') ? 'l.cbm' : 'NULL'} AS cbm,
           ${await hasColumn('client_leads', 'weight_kg') ? 'l.weight_kg' : 'NULL'} AS weightKg,
           l.relation_employee_id AS relationEmployeeId,
           ${hasEmployee ? `${employeeNameExpression('er')}` : 'NULL'} AS relationEmployeeName,
           l.procurement_employee_id AS procurementEmployeeId,
           ${hasEmployee ? `${employeeNameExpression('ep')}` : 'NULL'} AS procurementEmployeeName,
           l.portfolio_id AS portfolioId,
           ${hasPortfolios ? 'p.name' : 'NULL'} AS portfolioName,
           l.notes,
           l.created_by AS createdBy,
           ${hasEmployee ? `${employeeNameExpression('ec')}` : 'NULL'} AS createdByName,
           l.created_on AS createdOn
    FROM client_leads l
    ${joins.join('\n    ')}
    ${whereSql(where)}
    ORDER BY l.created_on DESC, l.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  const rows = await queryRows(sql, params);

  let summary = null;
  if (args.includeSummary !== false) {
    summary = await buildLeadReportSummary(where, params, args.groupBy || 'daily');
  }

  return withPagination({ rows, summary }, limit, offset);
}

async function getLeadReport(args) {
  const list = await listLeadReports({ leadId: args.leadId, limit: 1, offset: 0, includeSummary: false });
  const lead = list.rows[0] || null;
  if (!lead) {
    return { lead: null, portfolio: null };
  }

  let portfolio = null;
  const portfolioId = Number(lead.portfolioId || 0);
  if (portfolioId > 0 && await tableExists('client_lead_portfolios')) {
    const rows = await queryRows(
      `SELECT p.id AS portfolioId,
              p.name,
              p.start_date AS startDate,
              p.end_date AS endDate,
              p.goal_total_leads AS goalTotalLeads,
              p.goal_conversion_rate AS goalConversionRate,
              p.relation_employee_id AS relationEmployeeId,
              p.procurement_employee_id AS procurementEmployeeId,
              p.notes,
              p.created_by AS createdBy,
              p.created_on AS createdOn
       FROM client_lead_portfolios p
       WHERE p.id = ?
       LIMIT 1`,
      [portfolioId]
    );
    portfolio = rows[0] || null;
  }

  return { lead, portfolio };
}

async function listOrderFormReports(args) {
  const info = await resolveOrderFormInfo(true);
  const c = info.columns;
  const hasItems = await tableExists('order_form_items');
  const hasLogs = await tableExists('order_form_status_logs');

  const joins = [];
  if (hasItems && c.id) {
    joins.push(
      `LEFT JOIN (
        SELECT order_form_id,
               COUNT(*) AS itemCount,
               COALESCE(SUM(line_total), 0) AS itemLineTotal,
               COALESCE(SUM(product_value), 0) AS productValue,
               MAX(created_at) AS latestItemAt
        FROM order_form_items
        GROUP BY order_form_id
      ) items ON items.order_form_id = o.${qid(c.id)}`
    );
  }
  if (hasLogs && c.id) {
    joins.push(
      `LEFT JOIN (
        SELECT order_form_id,
               COUNT(*) AS statusChangeCount,
               MAX(created_at) AS latestStatusAt
        FROM order_form_status_logs
        GROUP BY order_form_id
      ) logs ON logs.order_form_id = o.${qid(c.id)}`
    );
  }

  const where = [];
  const params = [];
  addEqual(where, params, `o.${qid(c.id)}`, args.orderId);
  if (c.clientId) addEqual(where, params, `o.${qid(c.clientId)}`, args.clientId);
  if (c.shipmentId) addEqual(where, params, `o.${qid(c.shipmentId)}`, args.shipmentId);
  if (c.status) addLike(where, params, `o.${qid(c.status)}`, args.status);
  if (c.assigned) addLike(where, params, `o.${qid(c.assigned)}`, args.assignedTo);
  if (c.preparedBy) addLike(where, params, `o.${qid(c.preparedBy)}`, args.preparedBy);
  if (c.orderType) addLike(where, params, `o.${qid(c.orderType)}`, args.orderType);
  if (c.created && args.createdFrom) {
    where.push(`o.${qid(c.created)} >= ?`);
    params.push(args.createdFrom);
  }
  if (c.created && args.createdTo) {
    where.push(`o.${qid(c.created)} < DATE_ADD(?, INTERVAL 1 DAY)`);
    params.push(args.createdTo);
  }
  if (args.search) {
    const parts = [];
    for (const column of [c.number, c.clientName, c.clientEmail, c.clientPhone, c.assigned, c.preparedBy, c.shipmentReference]) {
      if (column) {
        parts.push(`o.${qid(column)} LIKE ?`);
        params.push(like(args.search));
      }
    }
    if (parts.length > 0) {
      where.push(`(${parts.join(' OR ')})`);
    }
  }

  const { limit, offset } = pagination(args);
  const sql = `
    SELECT o.${qid(c.id)} AS orderId,
           ${columnExpression('o', c.number, `CAST(o.${qid(c.id)} AS CHAR)`)} AS orderNumber,
           ${columnExpression('o', c.orderDate || c.created)} AS orderDate,
           ${columnExpression('o', c.currency)} AS currency,
           ${columnExpression('o', c.assigned)} AS assignedTo,
           ${columnExpression('o', c.shipmentId)} AS shipmentId,
           ${columnExpression('o', c.shipmentReference)} AS shipmentReference,
           ${columnExpression('o', c.clientType)} AS clientType,
           ${columnExpression('o', c.clientId)} AS clientId,
           ${columnExpression('o', c.clientName)} AS clientName,
           ${columnExpression('o', c.clientEmail)} AS clientEmail,
           ${columnExpression('o', c.clientPhone)} AS clientPhone,
           ${columnExpression('o', c.preparedBy)} AS preparedBy,
           ${columnExpression('o', c.totalProductValue)} AS totalProductValue,
           ${columnExpression('o', c.totalLocalCourier)} AS totalLocalCourier,
           ${columnExpression('o', c.agencyFee)} AS agencyFee,
           ${columnExpression('o', c.total)} AS grandTotal,
           ${columnExpression('o', c.status, "'Draft'")} AS status,
           ${columnExpression('o', c.orderType)} AS orderType,
           ${columnExpression('o', c.created)} AS createdAt,
           ${hasItems ? 'COALESCE(items.itemCount, 0)' : 'NULL'} AS itemCount,
           ${hasItems ? 'COALESCE(items.itemLineTotal, 0)' : 'NULL'} AS itemLineTotal,
           ${hasItems ? 'COALESCE(items.productValue, 0)' : 'NULL'} AS itemProductValue,
           ${hasItems ? 'items.latestItemAt' : 'NULL'} AS latestItemAt,
           ${hasLogs ? 'COALESCE(logs.statusChangeCount, 0)' : 'NULL'} AS statusChangeCount,
           ${hasLogs ? 'logs.latestStatusAt' : 'NULL'} AS latestStatusAt
    FROM ${qid(info.table)} o
    ${joins.join('\n    ')}
    ${whereSql(where)}
    ORDER BY ${c.created ? `o.${qid(c.created)}` : `o.${qid(c.id)}`} DESC,
             o.${qid(c.id)} DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  const rows = await queryRows(sql, params);

  let summary = null;
  if (args.includeSummary !== false) {
    summary = await buildOrderFormReportSummary(info, where, params, args.groupBy || 'daily');
  }

  return withPagination({ rows, summary, sourceTable: info.table }, limit, offset);
}

async function getOrderFormReport(args) {
  if (!args.orderId && !args.orderNumber) {
    throw new Error('Provide orderId or orderNumber.');
  }

  const info = await resolveOrderFormInfo(true);
  const c = info.columns;
  const where = [];
  const params = [];
  if (args.orderId) {
    where.push(`o.${qid(c.id)} = ?`);
    params.push(args.orderId);
  } else if (c.number) {
    where.push(`o.${qid(c.number)} = ?`);
    params.push(args.orderNumber);
  } else {
    throw new Error(`Order number lookup is not available because '${info.table}' has no order number column.`);
  }

  const orderRows = await queryRows(
    `SELECT o.*
     FROM ${qid(info.table)} o
     ${whereSql(where)}
     ORDER BY o.${qid(c.id)} DESC
     LIMIT 1`,
    params
  );
  const order = orderRows[0] || null;
  if (!order) {
    return { order: null, items: [], statusLogs: [], purchaseProofs: [] };
  }

  const orderId = Number(order[c.id] || 0);
  const items = await loadOrderFormItems(orderId);
  const statusLogs = await loadOrderFormStatusLogs(orderId);
  const purchaseProofs = await loadOrderFormPurchaseProofs(orderId);

  return { order, items, statusLogs, purchaseProofs, sourceTable: info.table };
}

async function listLeaveApplications(args) {
  await requireTable('leave_applications');
  const hasEmployee = await tableExists('employee');
  const hasLeaveTypes = await tableExists('leave_types');
  const hasAssignments = await tableExists('leave_assignments');
  const hasLogs = await tableExists('leave_application_logs');

  const joins = [];
  if (hasEmployee) {
    joins.push('LEFT JOIN employee e ON e.employeeid = la.employee_id');
  }
  if (hasLeaveTypes) {
    joins.push('LEFT JOIN leave_types lt ON lt.id = la.leave_type_id');
  }
  if (hasAssignments) {
    joins.push(
      `LEFT JOIN (
        SELECT employee_id, leave_type_id, COALESCE(SUM(allocated_days), 0) AS allocatedDays
        FROM leave_assignments
        GROUP BY employee_id, leave_type_id
      ) assign ON assign.employee_id = la.employee_id AND assign.leave_type_id = la.leave_type_id`
    );
    joins.push(
      `LEFT JOIN (
        SELECT employee_id, leave_type_id, SUM(days_requested) AS consumedDays
        FROM leave_applications
        WHERE status = 'approved'
        GROUP BY employee_id, leave_type_id
      ) consumed ON consumed.employee_id = la.employee_id AND consumed.leave_type_id = la.leave_type_id`
    );
  }

  const where = [];
  const params = [];
  addEqual(where, params, 'la.id', args.applicationId);
  addEqual(where, params, 'la.employee_id', args.employeeId);
  addEqual(where, params, 'la.leave_type_id', args.leaveTypeId);
  addEqual(where, params, 'la.status', args.status);
  addLeaveStageFilter(where, args.stage);
  addDateRange(where, params, 'la.start_date', args.startFrom, args.startTo);
  addDateRange(where, params, 'la.end_date', args.endFrom, args.endTo);
  if (args.submittedFrom) {
    where.push('la.submitted_at >= ?');
    params.push(args.submittedFrom);
  }
  if (args.submittedTo) {
    where.push('la.submitted_at < DATE_ADD(?, INTERVAL 1 DAY)');
    params.push(args.submittedTo);
  }
  if (args.search) {
    const parts = ['CAST(la.id AS CHAR) LIKE ?', 'la.reason LIKE ?'];
    params.push(like(args.search), like(args.search));
    if (hasEmployee) {
      parts.push('e.firstname LIKE ?', 'e.lastname LIKE ?', "CONCAT(e.firstname, ' ', e.lastname) LIKE ?");
      params.push(like(args.search), like(args.search), like(args.search));
    }
    if (hasLeaveTypes) {
      parts.push('lt.name LIKE ?');
      params.push(like(args.search));
    }
    where.push(`(${parts.join(' OR ')})`);
  }

  const { limit, offset } = pagination(args);
  const rows = await queryRows(
    `SELECT la.id AS applicationId,
            la.employee_id AS employeeId,
            ${hasEmployee ? "NULLIF(TRIM(CONCAT(COALESCE(e.firstname, ''), ' ', COALESCE(e.lastname, ''))), '')" : 'NULL'} AS employeeName,
            ${hasEmployee ? 'e.position' : 'NULL'} AS employeePosition,
            ${hasEmployee ? 'e.department' : 'NULL'} AS employeeDepartment,
            la.leave_type_id AS leaveTypeId,
            ${hasLeaveTypes ? 'lt.name' : 'NULL'} AS leaveType,
            la.start_date AS startDate,
            la.end_date AS endDate,
            la.days_requested AS daysRequested,
            la.reason,
            la.status,
            la.admin_status AS adminStatus,
            la.admin_approver_id AS adminApproverId,
            la.admin_approved_at AS adminApprovedAt,
            la.management_status AS managementStatus,
            la.management_approver_id AS managementApproverId,
            la.management_approved_at AS managementApprovedAt,
            ${hasAssignments ? 'assign.allocatedDays' : 'NULL'} AS allocatedDays,
            ${hasAssignments ? 'COALESCE(consumed.consumedDays, 0)' : 'NULL'} AS consumedDays,
            ${hasAssignments ? 'GREATEST(COALESCE(assign.allocatedDays, 0) - COALESCE(consumed.consumedDays, 0), 0)' : 'NULL'} AS remainingDays,
            ${hasAssignments ? 'GREATEST(COALESCE(la.days_requested, 0) - GREATEST(COALESCE(assign.allocatedDays, 0) - COALESCE(consumed.consumedDays, 0), 0), 0)' : 'NULL'} AS overBalanceDays,
            ${hasLogs ? 'COALESCE(logs.logCount, 0)' : 'NULL'} AS logCount,
            la.submitted_at AS submittedAt,
            la.updated_at AS updatedAt,
            la.reviewed_by AS reviewedBy,
            la.reviewed_at AS reviewedAt,
            la.reviewer_note AS reviewerNote
     FROM leave_applications la
     ${hasLogs ? `LEFT JOIN (
       SELECT application_id, COUNT(*) AS logCount
       FROM leave_application_logs
       GROUP BY application_id
     ) logs ON logs.application_id = la.id` : ''}
     ${joins.join('\n     ')}
     ${whereSql(where)}
     ORDER BY la.submitted_at DESC, la.id DESC
     LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  const decoratedRows = rows.map(decorateLeaveApplicationRow);
  if (args.includeLogs) {
    const logsByApplication = await loadLeaveApplicationLogsForRows(decoratedRows);
    for (const row of decoratedRows) {
      row.logs = logsByApplication[String(row.applicationId)] || [];
    }
  }

  const summaryJoins = [];
  if (hasEmployee) {
    summaryJoins.push('LEFT JOIN employee e ON e.employeeid = la.employee_id');
  }
  if (hasLeaveTypes) {
    summaryJoins.push('LEFT JOIN leave_types lt ON lt.id = la.leave_type_id');
  }
  const summary = args.includeSummary !== false
    ? await summarizeLeaveApplications(where, params, hasLogs, summaryJoins)
    : null;

  return withPagination({ rows: decoratedRows, summary }, limit, offset);
}

async function reviewLeaveApplication(args) {
  await requireTable('leave_applications');
  if (!args.dryRun && args.confirm !== true) {
    throw new Error('Set confirm to true to update a leave application approval.');
  }

  const conn = await pool.getConnection();
  let proposal = null;
  try {
    const current = await loadLeaveApplicationState(conn, args.applicationId);
    if (!current) {
      throw new Error('Leave application not found.');
    }
    proposal = await buildLeaveReviewProposal(conn, current, args);
    if (args.dryRun) {
      return {
        dryRun: true,
        current,
        proposed: proposal,
      };
    }

    await conn.beginTransaction();
    try {
      if (args.stage === 'admin') {
        await conn.execute(
          `UPDATE leave_applications
           SET admin_status = ?, admin_approver_id = ?, admin_approved_at = ?,
               status = ?, updated_at = ?
           WHERE id = ?
           LIMIT 1`,
          [proposal.stageStatus, args.actorId, proposal.reviewedAt, proposal.status, proposal.reviewedAt, args.applicationId]
        );
      } else {
        await conn.execute(
          `UPDATE leave_applications
           SET management_status = ?, management_approver_id = ?, management_approved_at = ?,
               status = ?, updated_at = ?
           WHERE id = ?
           LIMIT 1`,
          [proposal.stageStatus, args.actorId, proposal.reviewedAt, proposal.status, proposal.reviewedAt, args.applicationId]
        );
      }
      if (await tableExists('leave_application_logs')) {
        await conn.execute(
          `INSERT INTO leave_application_logs (application_id, stage, action, action_by, action_at, note)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [args.applicationId, args.stage, proposal.logAction, args.actorId, proposal.reviewedAt, proposal.note]
        );
      }
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    }
  } finally {
    conn.release();
  }

  const detail = await listLeaveApplications({
    applicationId: args.applicationId,
    includeLogs: true,
    includeSummary: false,
    limit: 1,
    offset: 0,
  });
  return {
    action: 'review_leave_application',
    decision: args.decision,
    stage: args.stage,
    proposal,
    leaveApplication: detail.rows[0] || null,
  };
}

function addLeaveStageFilter(where, stage) {
  if (!stage) {
    return;
  }
  if (stage === 'admin') {
    where.push("la.status = 'pending' AND COALESCE(la.admin_status, 'pending') = 'pending'");
  } else if (stage === 'management') {
    where.push("la.status = 'pending' AND COALESCE(la.admin_status, 'pending') = 'approved' AND COALESCE(la.management_status, 'pending') = 'pending'");
  } else if (stage === 'completed') {
    where.push("COALESCE(la.management_status, '') = 'approved'");
  } else if (stage === 'rejected') {
    where.push("(la.status = 'rejected' OR COALESCE(la.admin_status, '') = 'rejected' OR COALESCE(la.management_status, '') = 'rejected')");
  } else if (stage === 'cancelled') {
    where.push("la.status = 'cancelled'");
  }
}

function decorateLeaveApplicationRow(row) {
  const decorated = {
    ...row,
    stageKey: normalizeLeaveApplicationStage(row.status, row.adminStatus, row.managementStatus),
  };
  decorated.stageLabel = leaveApplicationStageLabel(decorated.stageKey);
  return decorated;
}

function normalizeLeaveApplicationStage(status, adminStatus, managementStatus) {
  const currentStatus = String(status || '').toLowerCase();
  const admin = String(adminStatus || 'pending').toLowerCase();
  const management = String(managementStatus || 'pending').toLowerCase();
  if (currentStatus === 'cancelled') return 'cancelled';
  if (currentStatus === 'rejected' || admin === 'rejected' || management === 'rejected') return 'rejected';
  if (management === 'approved') return 'completed';
  if (admin === 'approved') return 'management';
  return 'admin';
}

function leaveApplicationStageLabel(stageKey) {
  if (stageKey === 'cancelled') return 'Cancelled';
  if (stageKey === 'rejected') return 'Rejected';
  if (stageKey === 'completed') return 'Completed';
  if (stageKey === 'management') return 'Management approval';
  return 'Admin approval';
}

async function summarizeLeaveApplications(where, params, hasLogs, joins) {
  const rows = await queryRows(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN la.status = 'approved' THEN 1 ELSE 0 END), 0) AS approved,
            COALESCE(SUM(CASE WHEN la.status = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected,
            COALESCE(SUM(CASE WHEN la.status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled,
            COALESCE(SUM(CASE WHEN la.status = 'pending' AND COALESCE(la.admin_status, 'pending') = 'pending' THEN 1 ELSE 0 END), 0) AS pendingAdmin,
            COALESCE(SUM(CASE WHEN la.status = 'pending' AND COALESCE(la.admin_status, 'pending') = 'approved' AND COALESCE(la.management_status, 'pending') = 'pending' THEN 1 ELSE 0 END), 0) AS pendingManagement,
            COALESCE(SUM(la.days_requested), 0) AS requestedDays
     FROM leave_applications la
     ${hasLogs ? `LEFT JOIN (
       SELECT application_id, COUNT(*) AS logCount
       FROM leave_application_logs
       GROUP BY application_id
     ) logs ON logs.application_id = la.id` : ''}
     ${joins.join('\n     ')}
     ${whereSql(where)}`,
    params
  );
  return rows[0] || {};
}

async function loadLeaveApplicationLogsForRows(rows) {
  if (!rows.length || !await tableExists('leave_application_logs')) {
    return {};
  }
  const ids = [...new Set(rows.map((row) => Number(row.applicationId)).filter((id) => id > 0))];
  if (!ids.length) {
    return {};
  }
  const hasEmployee = await tableExists('employee');
  const placeholders = ids.map(() => '?').join(', ');
  const logs = await queryRows(
    `SELECT l.id AS logId,
            l.application_id AS applicationId,
            l.stage,
            l.action,
            l.action_by AS actionBy,
            ${hasEmployee ? "NULLIF(TRIM(CONCAT(COALESCE(e.firstname, ''), ' ', COALESCE(e.lastname, ''))), '')" : 'NULL'} AS actorName,
            l.action_at AS actionAt,
            l.note
     FROM leave_application_logs l
     ${hasEmployee ? 'LEFT JOIN employee e ON e.employeeid = l.action_by' : ''}
     WHERE l.application_id IN (${placeholders})
     ORDER BY l.action_at DESC, l.id DESC`,
    ids
  );
  return groupBy(logs, 'applicationId');
}

async function loadLeaveApplicationState(conn, applicationId) {
  const hasEmployee = await tableExists('employee');
  const hasLeaveTypes = await tableExists('leave_types');
  const rows = await connectionRows(
    conn,
    `SELECT la.id AS applicationId,
            la.employee_id AS employeeId,
            ${hasEmployee ? "NULLIF(TRIM(CONCAT(COALESCE(e.firstname, ''), ' ', COALESCE(e.lastname, ''))), '')" : 'NULL'} AS employeeName,
            la.leave_type_id AS leaveTypeId,
            ${hasLeaveTypes ? 'lt.name' : 'NULL'} AS leaveType,
            la.start_date AS startDate,
            la.end_date AS endDate,
            la.days_requested AS daysRequested,
            la.reason,
            la.status,
            la.admin_status AS adminStatus,
            la.admin_approver_id AS adminApproverId,
            la.admin_approved_at AS adminApprovedAt,
            la.management_status AS managementStatus,
            la.management_approver_id AS managementApproverId,
            la.management_approved_at AS managementApprovedAt,
            la.submitted_at AS submittedAt,
            la.updated_at AS updatedAt
     FROM leave_applications la
     ${hasEmployee ? 'LEFT JOIN employee e ON e.employeeid = la.employee_id' : ''}
     ${hasLeaveTypes ? 'LEFT JOIN leave_types lt ON lt.id = la.leave_type_id' : ''}
     WHERE la.id = ?
     LIMIT 1`,
    [applicationId]
  );
  return rows[0] ? decorateLeaveApplicationRow(rows[0]) : null;
}

async function buildLeaveReviewProposal(conn, current, args) {
  const stage = args.stage;
  const decision = args.decision;
  const currentStatus = String(current.status || '').toLowerCase();
  const adminStatus = String(current.adminStatus || 'pending').toLowerCase();
  const managementStatus = String(current.managementStatus || 'pending').toLowerCase();

  if (currentStatus === 'cancelled') {
    throw new Error('This leave request was cancelled.');
  }
  if (stage === 'admin' && ['approved', 'rejected'].includes(adminStatus)) {
    throw new Error('Admin approval has already been recorded.');
  }
  if (stage === 'management' && adminStatus !== 'approved') {
    throw new Error('Management approval requires admin approval first.');
  }
  if (stage === 'management' && ['approved', 'rejected'].includes(managementStatus)) {
    throw new Error('Management approval has already been recorded.');
  }

  const reviewedAt = await databaseNow(conn);
  const stageStatus = decision === 'approve' ? 'approved' : 'rejected';
  const status = stage === 'admin'
    ? (decision === 'approve' ? 'pending' : 'rejected')
    : (decision === 'approve' ? 'approved' : 'rejected');
  const overBalance = decision === 'approve'
    ? await calculateLeaveOverBalance(conn, current.applicationId)
    : null;
  let note = truncateText(args.note || '', 800);
  if (overBalance?.overBalanceDays > 0) {
    const overdrawNote = `Over balance by ${formatLeaveDays(overBalance.overBalanceDays)} day(s).`;
    note = note
      ? truncateText(`${note} | ${overdrawNote}`, 800)
      : overdrawNote;
  }

  return {
    applicationId: current.applicationId,
    stage,
    decision,
    fromStatus: current.status,
    status,
    fromStageStatus: stage === 'admin' ? current.adminStatus : current.managementStatus,
    stageStatus,
    reviewedBy: args.actorId,
    reviewedAt,
    logAction: stageStatus,
    note,
    overBalance,
  };
}

async function calculateLeaveOverBalance(conn, applicationId) {
  if (!await tableExists('leave_assignments')) {
    return null;
  }
  const rows = await connectionRows(
    conn,
    `SELECT la.days_requested AS daysRequested,
            COALESCE(assigns.allocatedDays, 0) AS allocatedDays,
            COALESCE(consumed.consumedDays, 0) AS consumedDays
     FROM leave_applications la
     LEFT JOIN (
       SELECT employee_id, leave_type_id, COALESCE(SUM(allocated_days), 0) AS allocatedDays
       FROM leave_assignments
       GROUP BY employee_id, leave_type_id
     ) assigns ON assigns.employee_id = la.employee_id AND assigns.leave_type_id = la.leave_type_id
     LEFT JOIN (
       SELECT employee_id, leave_type_id, SUM(days_requested) AS consumedDays
       FROM leave_applications
       WHERE status = 'approved'
       GROUP BY employee_id, leave_type_id
     ) consumed ON consumed.employee_id = la.employee_id AND consumed.leave_type_id = la.leave_type_id
     WHERE la.id = ?
     LIMIT 1`,
    [applicationId]
  );
  const row = rows[0] || {};
  const daysRequested = Math.max(0, Number(row.daysRequested || 0));
  const allocatedDays = Math.max(0, Number(row.allocatedDays || 0));
  const consumedDays = Math.max(0, Number(row.consumedDays || 0));
  const remainingDays = Math.max(allocatedDays - consumedDays, 0);
  const overBalanceDays = Math.max(daysRequested - remainingDays, 0);
  return {
    daysRequested: roundMoney(daysRequested),
    allocatedDays: roundMoney(allocatedDays),
    consumedDays: roundMoney(consumedDays),
    remainingDays: roundMoney(remainingDays),
    overBalanceDays: roundMoney(overBalanceDays),
  };
}

function formatLeaveDays(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) ? String(number) : String(roundMoney(number));
}

async function listTimesheetReports(args) {
  await requireTable('timesheet_entries');
  const range = reportDateRange(args.startDate, args.endDate);
  const policy = await loadTimesheetPolicy();
  const rows = await loadTimesheetDailyRows({
    employeeId: args.employeeId,
    startDate: range.startDate,
    endDate: range.endDate,
    search: args.search,
    rowLimit: 5000,
  }, policy);
  const filteredRows = args.status
    ? rows.filter((row) => String(row.status || '').toLowerCase().includes(String(args.status).trim().toLowerCase()))
    : rows;
  const { limit, offset } = pagination(args);
  const pagedRows = filteredRows.slice(offset, offset + limit);

  let summary = null;
  if (args.includeSummary !== false) {
    summary = {
      range,
      policy,
      dashboard: summarizeTimesheetRows(filteredRows),
      statusCounts: countBy(filteredRows, 'status'),
      leaderboard: buildTimesheetLeaderboard(filteredRows).slice(0, 12),
      exceptionCounts: buildTimesheetExceptionCounts(filteredRows),
      leaveWorkflow: await loadLeaveWorkflowSummary(range, args.employeeId),
      earlyLateWorkflow: await loadEarlyLateWorkflowSummary(range, args.employeeId),
    };
  }

  return withPagination({ rows: pagedRows, summary }, limit, offset, filteredRows.length);
}

async function listWarehouseTimesheetReports(args) {
  await requireTable('warehouse_work_timesheets');
  const range = reportDateRange(args.startDate, args.endDate);
  const hasSchedule = await tableExists('warehouse_timesheet_schedules');
  const hasEmployee = await tableExists('employee');
  const hasShipment = await tableExists('shipment');

  const joins = [];
  if (hasSchedule) joins.push('LEFT JOIN warehouse_timesheet_schedules s ON s.id = w.schedule_id');
  if (hasEmployee) joins.push('LEFT JOIN employee e ON e.employeeid = w.employee_id');
  if (hasShipment && hasSchedule) joins.push('LEFT JOIN shipment sh ON sh.shipmentid = s.shipment_id');

  const dateExpr = hasSchedule ? 'COALESCE(DATE(w.clock_in_at), s.work_date)' : 'DATE(w.clock_in_at)';
  const where = [];
  const params = [];
  addEqual(where, params, 'w.employee_id', args.employeeId);
  if (hasSchedule) addEqual(where, params, 's.shipment_id', args.shipmentId);
  if (hasSchedule) addLike(where, params, 's.work_type', args.workType);
  addLike(where, params, 'w.payment_status', args.paymentStatus);
  where.push(`${dateExpr} >= ?`);
  params.push(range.startDate);
  where.push(`${dateExpr} <= ?`);
  params.push(range.endDate);
  if (args.search) {
    const parts = ['w.payment_status LIKE ?'];
    params.push(like(args.search));
    if (hasEmployee) {
      parts.push('e.firstname LIKE ?', 'e.lastname LIKE ?', 'e.position LIKE ?', 'e.department LIKE ?');
      params.push(like(args.search), like(args.search), like(args.search), like(args.search));
    }
    if (hasSchedule) {
      parts.push('s.work_type LIKE ?', 's.notes LIKE ?');
      params.push(like(args.search), like(args.search));
    }
    if (hasShipment) {
      parts.push('sh.shipmentname LIKE ?');
      params.push(like(args.search));
    }
    where.push(`(${parts.join(' OR ')})`);
  }

  const { limit, offset } = pagination(args);
  const sql = `
    SELECT w.id AS workTimesheetId,
           w.schedule_id AS scheduleId,
           w.employee_id AS employeeId,
           ${hasEmployee ? employeeNameExpression('e') : 'NULL'} AS employeeName,
           ${hasEmployee ? 'e.position' : 'NULL'} AS position,
           ${hasEmployee ? 'e.department' : 'NULL'} AS department,
           ${hasSchedule ? 's.work_date' : 'DATE(w.clock_in_at)'} AS workDate,
           ${hasSchedule ? 's.work_type' : 'NULL'} AS workType,
           ${hasSchedule ? 's.status' : 'NULL'} AS scheduleStatus,
           ${hasSchedule ? 's.shipment_id' : 'NULL'} AS shipmentId,
           ${hasShipment && hasSchedule ? 'sh.shipmentname' : 'NULL'} AS shipmentName,
           w.clock_in_at AS clockInAt,
           w.clock_out_at AS clockOutAt,
           w.total_hours AS totalHours,
           w.payment_status AS paymentStatus,
           w.payment_hourly_rate AS paymentHourlyRate,
           w.paid_amount AS paidAmount,
           w.paid_at AS paidAt,
           w.paid_by AS paidBy,
           w.clock_in_by AS clockInBy,
           w.clock_out_by AS clockOutBy,
           w.created_at AS createdAt,
           w.updated_at AS updatedAt
    FROM warehouse_work_timesheets w
    ${joins.join('\n    ')}
    ${whereSql(where)}
    ORDER BY ${dateExpr} DESC, w.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  const rows = await queryRows(sql, params);

  let summary = null;
  if (args.includeSummary !== false) {
    const summaryRows = await queryRows(
      `SELECT COUNT(*) AS totalRows,
              COALESCE(SUM(w.total_hours), 0) AS totalHours,
              COALESCE(SUM(w.paid_amount), 0) AS paidAmount,
              COALESCE(SUM(CASE WHEN LOWER(COALESCE(w.payment_status, '')) IN ('paid', 'completed') THEN 1 ELSE 0 END), 0) AS paidRows,
              COALESCE(SUM(CASE WHEN LOWER(COALESCE(w.payment_status, '')) NOT IN ('paid', 'completed') THEN 1 ELSE 0 END), 0) AS unpaidRows
       FROM warehouse_work_timesheets w
       ${hasSchedule ? 'LEFT JOIN warehouse_timesheet_schedules s ON s.id = w.schedule_id' : ''}
       ${whereSql(where)}`,
      params
    );
    const statusRows = await queryRows(
      `SELECT COALESCE(NULLIF(TRIM(w.payment_status), ''), 'Unspecified') AS label,
              COUNT(*) AS count
       FROM warehouse_work_timesheets w
       ${hasSchedule ? 'LEFT JOIN warehouse_timesheet_schedules s ON s.id = w.schedule_id' : ''}
       ${whereSql(where)}
       GROUP BY COALESCE(NULLIF(TRIM(w.payment_status), ''), 'Unspecified')
       ORDER BY count DESC`,
      params
    );
    summary = {
      range,
      totals: summaryRows[0] || {},
      paymentStatusDistribution: statusRows,
    };
  }

  return withPagination({ rows, summary }, limit, offset);
}

async function loadShipmentBudgetRows({ budgetTable, incomeTable, itemTable, type, budgetId, shipmentId, search }) {
  const hasShipment = await tableExists('shipment');
  const hasIncome = await tableExists(incomeTable);
  const hasItems = await tableExists(itemTable);
  const where = [];
  const params = [];

  addEqual(where, params, 'b.`id`', budgetId);
  addEqual(where, params, 'b.`shipmentid`', shipmentId);
  if (search) {
    if (hasShipment) {
      where.push('(s.`shipmentname` LIKE ? OR s.`shipmentstatus` LIKE ? OR s.`currentlocation` LIKE ?)');
      params.push(like(search), like(search), like(search));
    } else {
      where.push('CAST(b.`shipmentid` AS CHAR) LIKE ?');
      params.push(like(search));
    }
  }

  const sql = `
    SELECT '${type}' AS budgetType,
           b.id AS budgetId,
           b.shipmentid AS shipmentId,
           ${hasShipment ? 's.shipmentname' : 'NULL'} AS shipmentName,
           ${hasShipment ? 's.shipmentstatus' : 'NULL'} AS shipmentStatus,
           ${hasShipment ? 's.currentlocation' : 'NULL'} AS currentLocation,
           ${hasIncome ? 'COALESCE(income.expectedIncome, 0)' : 'NULL'} AS expectedIncome,
           ${hasIncome ? 'COALESCE(income.expectedDiscount, 0)' : 'NULL'} AS expectedDiscount,
           ${hasIncome ? 'COALESCE(income.collectedAmount, 0)' : 'NULL'} AS collectedAmount,
           ${hasItems ? 'COALESCE(items.expectedExpense, 0)' : 'NULL'} AS expectedExpense,
           ${hasItems ? 'COALESCE(items.spentAmount, 0)' : 'NULL'} AS spentAmount,
           ${hasItems ? '(COALESCE(items.expectedExpense, 0) - COALESCE(items.spentAmount, 0))' : 'NULL'} AS remainingExpense,
           b.created_on AS createdOn,
           b.updated_on AS updatedOn
    FROM ${qid(budgetTable)} b
    ${hasShipment ? 'LEFT JOIN `shipment` s ON s.`shipmentid` = b.`shipmentid`' : ''}
    ${hasIncome ? `LEFT JOIN (
      SELECT budget_id,
             COALESCE(SUM(expected_amount), 0) AS expectedIncome,
             COALESCE(SUM(expected_discount), 0) AS expectedDiscount,
             COALESCE(SUM(collected_amount), 0) AS collectedAmount
      FROM ${qid(incomeTable)}
      GROUP BY budget_id
    ) income ON income.budget_id = b.id` : ''}
    ${hasItems ? `LEFT JOIN (
      SELECT budget_id,
             COALESCE(SUM(expected_amount), 0) AS expectedExpense,
             COALESCE(SUM(spent_amount), 0) AS spentAmount
      FROM ${qid(itemTable)}
      GROUP BY budget_id
    ) items ON items.budget_id = b.id` : ''}
    ${whereSql(where)}
  `;
  return queryRows(sql, params);
}

function shipmentBudgetConfig(type) {
  if (type === 'shipping') {
    return {
      type: 'shipping',
      budgetTable: 'shipping_shipment_budget',
      incomeTable: 'shipping_shipment_budget_income',
      itemTable: 'shipping_shipment_budget_item',
      logTable: 'shipping_shipment_budget_log',
    };
  }

  return {
    type: 'customs',
    budgetTable: 'shipment_budget',
    incomeTable: 'shipment_budget_income',
    itemTable: 'shipment_budget_item',
    logTable: 'shipment_budget_log',
  };
}

async function loadShipmentBudgetDetail(config, args) {
  if (!args.budgetId && !args.shipmentId) {
    throw new Error('Provide budgetId or shipmentId.');
  }
  await requireTable(config.budgetTable);

  const list = await listShipmentBudgets({
    budgetType: config.type,
    budgetId: args.budgetId,
    shipmentId: args.shipmentId,
    limit: 1,
    offset: 0,
  });
  const budget = list.rows[0] || null;
  if (!budget) {
    return { budget: null, incomes: [], items: [], logs: [], totals: null };
  }

  const budgetId = Number(budget.budgetId || 0);
  const incomes = await loadShipmentBudgetIncomeRows(config.incomeTable, config.type, budgetId);
  const items = await loadShipmentBudgetItemRows(config.itemTable, budgetId);
  const logs = args.includeLogs === false
    ? []
    : await loadShipmentBudgetLogRows(config.logTable, budgetId, args.logLimit);

  return {
    budget,
    incomes,
    items,
    logs,
    totals: summarizeShipmentBudgetDetail(incomes, items),
  };
}

async function loadShipmentBudgetIncomeRows(incomeTable, type, budgetId) {
  if (!await tableExists(incomeTable)) {
    return [];
  }
  const hasClientId = await hasColumn(incomeTable, 'client_id');
  const hasClients = hasClientId && await tableExists('Clients');
  return queryRows(
    `SELECT i.id AS incomeId,
            i.budget_id AS budgetId,
            ${hasClientId ? 'i.client_id' : 'NULL'} AS clientId,
            ${hasClients ? clientNameExpression('cl', 'firstname', 'lastname', 'business') : 'NULL'} AS clientName,
            i.label,
            i.expected_amount AS expectedAmount,
            ${await hasColumn(incomeTable, 'expected_discount') ? 'i.expected_discount' : 'NULL'} AS expectedDiscount,
            i.collected_amount AS collectedAmount,
            (COALESCE(i.expected_amount, 0) - COALESCE(${await hasColumn(incomeTable, 'expected_discount') ? 'i.expected_discount' : '0'}, 0)) AS netExpectedAmount,
            ((COALESCE(i.expected_amount, 0) - COALESCE(${await hasColumn(incomeTable, 'expected_discount') ? 'i.expected_discount' : '0'}, 0)) - COALESCE(i.collected_amount, 0)) AS collectionBalance,
            i.created_on AS createdOn,
            i.updated_on AS updatedOn,
            '${type}' AS budgetType
     FROM ${qid(incomeTable)} i
     ${hasClients ? 'LEFT JOIN Clients cl ON cl.userid = i.client_id' : ''}
     WHERE i.budget_id = ?
     ORDER BY i.id ASC`,
    [budgetId]
  );
}

async function loadShipmentBudgetItemRows(itemTable, budgetId) {
  if (!await tableExists(itemTable)) {
    return [];
  }
  return queryRows(
    `SELECT id AS itemId,
            budget_id AS budgetId,
            title,
            expected_amount AS expectedAmount,
            spent_amount AS spentAmount,
            (COALESCE(expected_amount, 0) - COALESCE(spent_amount, 0)) AS remainingAmount,
            created_on AS createdOn,
            updated_on AS updatedOn
     FROM ${qid(itemTable)}
     WHERE budget_id = ?
     ORDER BY id ASC`,
    [budgetId]
  );
}

async function loadShipmentBudgetLogRows(logTable, budgetId, limit) {
  if (!await tableExists(logTable)) {
    return [];
  }
  const safeLimit = clampInt(limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  return queryRows(
    `SELECT id AS logId,
            budget_id AS budgetId,
            event_type AS eventType,
            user_id AS userId,
            user_name AS userName,
            message,
            created_on AS createdOn
     FROM ${qid(logTable)}
     WHERE budget_id = ?
     ORDER BY created_on DESC, id DESC
     LIMIT ${safeLimit}`,
    [budgetId]
  );
}

function summarizeShipmentBudgetDetail(incomes, items) {
  const totals = {
    expectedIncome: 0,
    expectedDiscount: 0,
    netExpectedIncome: 0,
    collectedAmount: 0,
    collectionBalance: 0,
    expectedExpense: 0,
    spentAmount: 0,
    remainingExpense: 0,
    projectedNet: 0,
    actualNet: 0,
  };

  for (const row of incomes) {
    totals.expectedIncome += Number(row.expectedAmount || 0);
    totals.expectedDiscount += Number(row.expectedDiscount || 0);
    totals.netExpectedIncome += Number(row.netExpectedAmount || 0);
    totals.collectedAmount += Number(row.collectedAmount || 0);
    totals.collectionBalance += Number(row.collectionBalance || 0);
  }
  for (const row of items) {
    totals.expectedExpense += Number(row.expectedAmount || 0);
    totals.spentAmount += Number(row.spentAmount || 0);
    totals.remainingExpense += Number(row.remainingAmount || 0);
  }
  totals.projectedNet = totals.netExpectedIncome - totals.expectedExpense;
  totals.actualNet = totals.collectedAmount - totals.spentAmount;

  for (const key of Object.keys(totals)) {
    totals[key] = Number(totals[key].toFixed(2));
  }
  totals.status = totals.spentAmount > totals.expectedExpense
    ? 'overspent'
    : totals.remainingExpense > 0
      ? 'saved'
      : 'balanced';
  return totals;
}

async function loadCargoCollections(cargoId) {
  if (!await tableExists('cargocollection')) {
    return [];
  }
  const hasCollectionImage = await hasColumn('cargocollection', 'collectionimg');
  return queryRows(
    `SELECT cargocollectionid AS collectionId,
            cargoid AS cargoId,
            fullname AS fullName,
            phonenumber AS phoneNumber,
            idtype AS idType,
            idnumber AS idNumber,
            collectionlocation AS collectionLocation,
            ${hasCollectionImage ? 'collectionimg' : 'NULL'} AS collectionImage,
            collectedon AS collectedOn
     FROM cargocollection
     WHERE cargoid = ?
     ORDER BY cargocollectionid DESC
     LIMIT 20`,
    [cargoId]
  );
}

async function loadPackageUnits(packageId, limit) {
  if (!await tableExists('cargo_package_units')) {
    return [];
  }
  const hasStages = await tableExists('cargo_package_unit_stage');
  const safeLimit = clampInt(limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const rows = await queryRows(
    `SELECT u.id AS unitId,
            u.package_id AS packageId,
            u.unit_index AS unitIndex,
            u.checked_at AS checkedAt,
            u.checked_by AS checkedBy,
            u.created_at AS createdAt
     FROM cargo_package_units u
     WHERE u.package_id = ?
     ORDER BY u.unit_index ASC, u.id ASC
     LIMIT ${safeLimit}`,
    [packageId]
  );

  if (!hasStages || rows.length === 0) {
    return rows;
  }

  const unitIds = rows.map((row) => Number(row.unitId)).filter(Boolean);
  const placeholders = unitIds.map(() => '?').join(',');
  const stages = await queryRows(
    `SELECT unit_id AS unitId, stage, checked_at AS checkedAt, checked_by AS checkedBy
     FROM cargo_package_unit_stage
     WHERE unit_id IN (${placeholders})
     ORDER BY unit_id ASC, stage ASC`,
    unitIds
  );
  const byUnit = groupBy(stages, 'unitId');
  return rows.map((row) => ({ ...row, stages: byUnit.get(String(row.unitId)) || [] }));
}

async function loadPackageStageSummary(packageId) {
  if (!await tableExists('cargo_package_units') || !await tableExists('cargo_package_unit_stage')) {
    return [];
  }
  return queryRows(
    `SELECT st.stage AS stage,
            COUNT(*) AS checkedUnits,
            MIN(st.checked_at) AS firstCheckedAt,
            MAX(st.checked_at) AS lastCheckedAt
     FROM cargo_package_units u
     INNER JOIN cargo_package_unit_stage st ON st.unit_id = u.id
     WHERE u.package_id = ?
     GROUP BY st.stage
     ORDER BY st.stage ASC`,
    [packageId]
  );
}

async function loadShipmentCalendar(shipmentId) {
  if (!await tableExists('shipmentcalendar')) {
    return [];
  }
  return queryRows(
    `SELECT shipmentcalendarid AS calendarId,
            shipmentid AS shipmentId,
            estimateddeparture AS estimatedDeparture,
            estimatedarrival AS estimatedArrival,
            loadingdate AS loadingDate,
            calendarstatus AS calendarStatus,
            agent,
            createdon AS createdOn,
            createdby AS createdBy,
            updatedon AS updatedOn
     FROM shipmentcalendar
     WHERE shipmentid = ?
     ORDER BY shipmentcalendarid DESC`,
    [shipmentId]
  );
}

async function loadShipmentUpdates(shipmentId, limit) {
  if (!await tableExists('shipmentupdate')) {
    return [];
  }
  const safeLimit = clampInt(limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  return queryRows(
    `SELECT shipmentupdateid AS updateId,
            shipmentid AS shipmentId,
            location,
            shipmentstatus AS shipmentStatus,
            updateinfo AS updateInfo,
            timestamp,
            user
     FROM shipmentupdate
     WHERE shipmentid = ?
     ORDER BY timestamp DESC, shipmentupdateid DESC
     LIMIT ${safeLimit}`,
    [shipmentId]
  );
}

async function loadRequisitionItems(requisitionId) {
  if (!await tableExists('requisition_items')) {
    return [];
  }
  const hasMonthlyBudget = await tableExists('monthly_budget_entry');
  const hasCategory = await tableExists('monthly_budget_category');
  const hasShipmentBudget = await tableExists('shipment_budget') && await tableExists('shipment_budget_item');
  const hasShipment = await tableExists('shipment');
  const joins = [];

  if (hasMonthlyBudget) {
    joins.push('LEFT JOIN monthly_budget_entry mbe ON mbe.id = ri.budget_item_id AND (ri.shipment_id IS NULL OR ri.shipment_id = 0)');
  }
  if (hasCategory) {
    joins.push('LEFT JOIN monthly_budget_category mbc ON mbc.id = mbe.category_id');
  }
  if (hasShipmentBudget) {
    joins.push(
      `LEFT JOIN shipment_budget_item sbi
         ON sbi.id = ri.budget_item_id
        AND ri.shipment_id IS NOT NULL
        AND ri.shipment_id > 0
        AND EXISTS (
          SELECT 1 FROM shipment_budget sb
          WHERE sb.id = sbi.budget_id AND sb.shipmentid = ri.shipment_id
        )`
    );
  }
  if (hasShipment) {
    joins.push('LEFT JOIN shipment s ON s.shipmentid = ri.shipment_id');
  }

  return queryRows(
    `SELECT ri.id AS itemId,
            ri.requisition_id AS requisitionId,
            ri.type_id AS typeId,
            ri.shipment_id AS shipmentId,
            ${hasShipment ? 's.shipmentname' : 'NULL'} AS shipmentName,
            ri.budget_item_id AS budgetItemId,
            ri.item_name AS itemName,
            ri.quantity,
            ri.unit_price AS unitPrice,
            ri.currency,
            (ri.quantity * ri.unit_price) AS lineTotal,
            ${hasMonthlyBudget ? 'mbe.budget_item' : 'NULL'} AS monthlyBudgetItem,
            ${hasCategory ? 'mbc.name' : 'NULL'} AS monthlyBudgetCategory,
            ${hasMonthlyBudget ? "DATE_FORMAT(mbe.budget_month, '%Y-%m')" : 'NULL'} AS monthlyBudgetMonth,
            ${hasShipmentBudget ? 'sbi.title' : 'NULL'} AS shipmentBudgetItem,
            ${hasShipmentBudget ? '(COALESCE(sbi.expected_amount, 0) - COALESCE(sbi.spent_amount, 0))' : 'NULL'} AS shipmentBudgetBalance,
            ri.created_at AS createdAt
     FROM requisition_items ri
     ${joins.join('\n     ')}
     WHERE ri.requisition_id = ?
     ORDER BY ri.id ASC`,
    [requisitionId]
  );
}

async function loadRequisitionLogs(requisitionId, limit) {
  if (!await tableExists('requisition_logs')) {
    return [];
  }
  const safeLimit = clampInt(limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  return queryRows(
    `SELECT id AS logId,
            requisition_id AS requisitionId,
            action,
            actor_id AS actorId,
            created_at AS createdAt
     FROM requisition_logs
     WHERE requisition_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT ${safeLimit}`,
    [requisitionId]
  );
}

async function loadPaymentVoucherItems(voucherId) {
  if (!await tableExists('payment_voucher_items')) {
    return [];
  }
  const hasRequisitionItemId = await hasColumn('payment_voucher_items', 'requisition_item_id');
  const hasBudgetItemId = await hasColumn('payment_voucher_items', 'budget_item_id');
  const hasShipmentId = await hasColumn('payment_voucher_items', 'shipment_id');
  const hasMonthlyBudget = hasBudgetItemId && await tableExists('monthly_budget_entry');
  const hasShipmentBudget = hasBudgetItemId && hasShipmentId && await tableExists('shipment_budget') && await tableExists('shipment_budget_item');
  const hasShipment = hasShipmentId && await tableExists('shipment');
  const hasAllocatedAmount = await hasColumn('payment_voucher_items', 'allocated_amount');
  const joins = [];
  if (hasMonthlyBudget) {
    const monthlyBudgetJoinGuard = hasShipmentId ? ' AND (pvi.shipment_id IS NULL OR pvi.shipment_id = 0)' : '';
    joins.push(`LEFT JOIN monthly_budget_entry mbe ON mbe.id = pvi.budget_item_id${monthlyBudgetJoinGuard}`);
  }
  if (hasShipmentBudget) {
    joins.push('LEFT JOIN shipment_budget_item sbi ON sbi.id = pvi.budget_item_id AND pvi.shipment_id IS NOT NULL AND pvi.shipment_id > 0');
  }
  if (hasShipment) {
    joins.push('LEFT JOIN shipment s ON s.shipmentid = pvi.shipment_id');
  }
  return queryRows(
    `SELECT pvi.id AS itemId,
            pvi.voucher_id AS voucherId,
            ${hasRequisitionItemId ? 'pvi.requisition_item_id' : 'NULL'} AS requisitionItemId,
            pvi.item_name AS itemName,
            pvi.quantity,
            pvi.unit_price AS unitPrice,
            pvi.currency,
            ${hasBudgetItemId ? 'pvi.budget_item_id' : 'NULL'} AS budgetItemId,
            ${hasShipmentId ? 'pvi.shipment_id' : 'NULL'} AS shipmentId,
            ${hasShipment ? 's.shipmentname' : 'NULL'} AS shipmentName,
            ${hasAllocatedAmount ? 'pvi.allocated_amount' : 'NULL'} AS allocatedAmount,
            (pvi.quantity * pvi.unit_price) AS lineTotal,
            ${hasMonthlyBudget ? 'mbe.budget_item' : 'NULL'} AS monthlyBudgetItem,
            ${hasShipmentBudget ? 'sbi.title' : 'NULL'} AS shipmentBudgetItem,
            pvi.created_at AS createdAt
     FROM payment_voucher_items pvi
     ${joins.join('\n     ')}
     WHERE pvi.voucher_id = ?
     ORDER BY pvi.id ASC`,
    [voucherId]
  );
}

async function loadPaymentVoucherProofs(voucherId) {
  if (!await tableExists('payment_voucher_proofs')) {
    return [];
  }
  return queryRows(
    `SELECT id AS proofId,
            voucher_id AS voucherId,
            proof_path AS proofPath,
            proof_name AS proofName,
            proof_type AS proofType,
            proof_size AS proofSize,
            uploaded_by AS uploadedBy,
            uploaded_at AS uploadedAt
     FROM payment_voucher_proofs
     WHERE voucher_id = ?
     ORDER BY uploaded_at DESC, id DESC`,
    [voucherId]
  );
}

async function loadSimpleLogs(table, idColumn, foreignColumn, foreignId, limit) {
  if (!await tableExists(table)) {
    return [];
  }
  const safeLimit = clampInt(limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  return queryRows(
    `SELECT ${qid(idColumn)} AS logId,
            ${qid(foreignColumn)} AS recordId,
            event,
            timestamp,
            user
     FROM ${qid(table)}
     WHERE ${qid(foreignColumn)} = ?
     ORDER BY timestamp DESC, ${qid(idColumn)} DESC
     LIMIT ${safeLimit}`,
    [foreignId]
  );
}

async function pickColumn(table, candidates) {
  for (const candidate of candidates) {
    if (await hasColumn(table, candidate)) {
      return candidate;
    }
  }
  return null;
}

function columnExpression(alias, column, fallback = 'NULL') {
  return column ? `${alias}.${qid(column)}` : fallback;
}

function numericExpression(expression) {
  return `CAST(REPLACE(COALESCE(${expression}, '0'), ',', '') AS DECIMAL(18,2))`;
}

function clientNameExpression(alias, firstColumn, lastColumn, businessColumn = null) {
  const first = firstColumn ? `COALESCE(${alias}.${qid(firstColumn)}, '')` : "''";
  const last = lastColumn ? `COALESCE(${alias}.${qid(lastColumn)}, '')` : "''";
  const business = businessColumn ? `${alias}.${qid(businessColumn)}` : 'NULL';
  return `COALESCE(NULLIF(TRIM(CONCAT(${first}, ' ', ${last})), ''), NULLIF(TRIM(COALESCE(${business}, '')), ''))`;
}

function employeeNameExpression(alias) {
  return `COALESCE(NULLIF(TRIM(CONCAT(COALESCE(${alias}.firstname, ''), ' ', COALESCE(${alias}.lastname, ''))), ''), CONCAT('Employee #', ${alias}.employeeid))`;
}

async function loadClientMatchedLeads(client, limit) {
  if (!await tableExists('client_leads')) {
    return [];
  }
  const phone = String(client.phone || '').trim();
  const email = String(client.email || '').trim();
  const name = String(client.clientName || '').trim();
  const where = [];
  const params = [];
  if (phone) {
    where.push('LOWER(TRIM(l.lead_phone)) = LOWER(TRIM(?))');
    params.push(phone);
  }
  if (email) {
    where.push('LOWER(TRIM(l.lead_email)) = LOWER(TRIM(?))');
    params.push(email);
  }
  if (where.length === 0 && name) {
    where.push('l.lead_name LIKE ?');
    params.push(like(name));
  }
  if (where.length === 0) {
    return [];
  }
  const safeLimit = clampInt(limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const hasEmployee = await tableExists('employee');
  return queryRows(
    `SELECT l.id AS leadId,
            l.lead_name AS leadName,
            l.lead_phone AS leadPhone,
            l.lead_email AS leadEmail,
            l.district,
            l.service_interest AS serviceInterest,
            l.permission_status AS permissionStatus,
            l.lead_status AS leadStatus,
            l.relation_employee_id AS relationEmployeeId,
            ${hasEmployee ? employeeNameExpression('er') : 'NULL'} AS relationEmployeeName,
            l.created_on AS createdOn
     FROM client_leads l
     ${hasEmployee ? 'LEFT JOIN employee er ON er.employeeid = l.relation_employee_id' : ''}
     WHERE (${where.join(' OR ')})
     ORDER BY l.created_on DESC, l.id DESC
     LIMIT ${safeLimit}`,
    params
  );
}

async function resolveOrderFormInfo(required = true) {
  const table = await resolveTable([
    'order_forms',
    'orderforms',
    'order_form',
    'orders',
    'orderform',
    'order_form_table',
    'order_forms_table',
    'order_form_requests',
  ]);
  if (!table) {
    if (required) {
      throw new Error('No order form table was found in the configured database.');
    }
    return null;
  }

  const columns = {
    id: await pickColumn(table, ['id', 'order_id', 'orderid']),
    number: await pickColumn(table, ['order_number', 'ordernumber', 'reference_number', 'referenceno', 'reference', 'code']),
    orderDate: await pickColumn(table, ['order_date', 'date']),
    currency: await pickColumn(table, ['currency', 'order_currency']),
    assigned: await pickColumn(table, ['assigned_to', 'assignedto', 'assignee', 'assignee_name', 'assigned']),
    shipmentId: await pickColumn(table, ['shipment_id', 'shipmentid']),
    shipmentReference: await pickColumn(table, ['shipment_reference', 'shipment_ref', 'shipment_name']),
    clientType: await pickColumn(table, ['client_type']),
    clientId: await pickColumn(table, ['client_id', 'userid', 'customer_id']),
    clientName: await pickColumn(table, ['client_name', 'clientname', 'customer_name', 'customer']),
    clientEmail: await pickColumn(table, ['client_email', 'email', 'customer_email']),
    clientPhone: await pickColumn(table, ['client_phone', 'phone', 'phonenumber', 'customer_phone']),
    preparedBy: await pickColumn(table, ['prepared_by', 'preparedby', 'created_by', 'createdby', 'sales_person', 'salesperson', 'sales_rep', 'salesrep']),
    totalProductValue: await pickColumn(table, ['total_product_value', 'product_total', 'subtotal']),
    totalLocalCourier: await pickColumn(table, ['total_local_courier', 'local_courier_total', 'local_shipping_total']),
    agencyFee: await pickColumn(table, ['agency_fee', 'service_fee']),
    total: await pickColumn(table, ['grand_total', 'total_amount', 'amount', 'total']),
    status: await pickColumn(table, ['status', 'order_status', 'current_status']),
    created: await pickColumn(table, ['created_at', 'createdon', 'created', 'created_date', 'createdtime', 'created_time', 'timestamp', 'date', 'order_date']),
    publicToken: await pickColumn(table, ['public_token', 'token']),
    orderType: await pickColumn(table, ['order_type', 'orderform_type', 'form_type']),
  };

  if (!columns.id) {
    if (required) {
      throw new Error(`No order id column was found in '${table}'.`);
    }
    return null;
  }

  return { table, columns };
}

async function buildLeadReportSummary(where, params, groupBy) {
  const whereClause = whereSql(where);
  const totals = await queryRows(
    `SELECT COUNT(*) AS totalLeads,
            COALESCE(SUM(CASE WHEN LOWER(COALESCE(l.lead_status, '')) LIKE '%convert%' THEN 1 ELSE 0 END), 0) AS convertedLeads,
            COALESCE(SUM(CASE WHEN l.created_on >= DATE_SUB(NOW(), INTERVAL 7 DAY) THEN 1 ELSE 0 END), 0) AS recent7Days,
            COALESCE(SUM(CASE WHEN LOWER(COALESCE(l.lead_status, '')) NOT LIKE '%convert%' THEN 1 ELSE 0 END), 0) AS openLeads
     FROM client_leads l
     ${whereClause}`,
    params
  );
  const statusDistribution = await queryRows(
    `SELECT COALESCE(NULLIF(TRIM(l.lead_status), ''), 'Unspecified') AS label,
            COUNT(*) AS count
     FROM client_leads l
     ${whereClause}
     GROUP BY COALESCE(NULLIF(TRIM(l.lead_status), ''), 'Unspecified')
     ORDER BY count DESC`,
    params
  );
  const permissionDistribution = await queryRows(
    `SELECT COALESCE(NULLIF(TRIM(l.permission_status), ''), 'Unspecified') AS label,
            COUNT(*) AS count
     FROM client_leads l
     ${whereClause}
     GROUP BY COALESCE(NULLIF(TRIM(l.permission_status), ''), 'Unspecified')
     ORDER BY count DESC`,
    params
  );
  const districtDistribution = await queryRows(
    `SELECT COALESCE(NULLIF(TRIM(l.district), ''), 'Unspecified') AS label,
            COUNT(*) AS count
     FROM client_leads l
     ${whereClause}
     GROUP BY COALESCE(NULLIF(TRIM(l.district), ''), 'Unspecified')
     ORDER BY count DESC
     LIMIT 20`,
    params
  );
  const period = reportPeriodExpression('l.created_on', groupBy);
  const volume = await queryRows(
    `SELECT ${period.select} AS period,
            COUNT(*) AS count
     FROM client_leads l
     ${whereClause}
     GROUP BY ${period.groupBy}
     ORDER BY period ASC
     LIMIT 120`,
    params
  );
  const totalRow = totals[0] || {};
  const totalLeads = Number(totalRow.totalLeads || 0);
  const convertedLeads = Number(totalRow.convertedLeads || 0);
  return {
    totals: {
      ...totalRow,
      conversionRate: totalLeads > 0 ? Number(((convertedLeads / totalLeads) * 100).toFixed(1)) : 0,
    },
    statusDistribution,
    permissionDistribution,
    districtDistribution,
    volume: {
      groupBy,
      rows: volume,
    },
  };
}

async function buildOrderFormReportSummary(info, where, params, groupBy) {
  const c = info.columns;
  const whereClause = whereSql(where);
  const totalExpr = c.total ? `COALESCE(SUM(o.${qid(c.total)}), 0)` : '0';
  const totals = await queryRows(
    `SELECT COUNT(*) AS totalOrders,
            ${totalExpr} AS totalValue
     FROM ${qid(info.table)} o
     ${whereClause}`,
    params
  );
  const statusDistribution = c.status
    ? await queryRows(
      `SELECT COALESCE(NULLIF(TRIM(o.${qid(c.status)}), ''), 'Unspecified') AS label,
              COUNT(*) AS count,
              ${c.total ? `COALESCE(SUM(o.${qid(c.total)}), 0)` : '0'} AS value
       FROM ${qid(info.table)} o
       ${whereClause}
       GROUP BY COALESCE(NULLIF(TRIM(o.${qid(c.status)}), ''), 'Unspecified')
       ORDER BY count DESC`,
      params
    )
    : [];
  const assigneeDistribution = c.assigned
    ? await queryRows(
      `SELECT COALESCE(NULLIF(TRIM(o.${qid(c.assigned)}), ''), 'Unassigned') AS label,
              COUNT(*) AS count,
              ${c.total ? `COALESCE(SUM(o.${qid(c.total)}), 0)` : '0'} AS value
       FROM ${qid(info.table)} o
       ${whereClause}
       GROUP BY COALESCE(NULLIF(TRIM(o.${qid(c.assigned)}), ''), 'Unassigned')
       ORDER BY count DESC
       LIMIT 20`,
      params
    )
    : [];
  const volume = c.created
    ? await queryRows(
      `SELECT ${reportPeriodExpression(`o.${qid(c.created)}`, groupBy).select} AS period,
              COUNT(*) AS count,
              ${c.total ? `COALESCE(SUM(o.${qid(c.total)}), 0)` : '0'} AS value
       FROM ${qid(info.table)} o
       ${whereClause}
       GROUP BY ${reportPeriodExpression(`o.${qid(c.created)}`, groupBy).groupBy}
       ORDER BY period ASC
       LIMIT 120`,
      params
    )
    : [];
  return {
    totals: totals[0] || {},
    statusDistribution,
    assigneeDistribution,
    volume: {
      groupBy,
      rows: volume,
    },
  };
}

async function getImportProductReport(args) {
  const from = String(args.from || '').trim();
  const to = String(args.to || '').trim();
  if (from > to) {
    throw new Error('from must be on or before to.');
  }

  const startSql = `${from} 00:00:00`;
  const endSql = `${to} 23:59:59`;
  const productCategoryKey = args.productCategory ? importProductCategoryKey(args.productCategory) : '';
  const categoryLimit = clampInt(args.categoryLimit, 20, 1, 100);
  const clientLimit = clampInt(args.clientLimit, 100, 1, 500);
  const topImporterLimit = clampInt(args.topImporterLimit, 10, 1, 50);
  const emptyTrend = buildImportProductTrend(from, to, {});

  const emptyReport = (missingSources = [], sourceOverrides = {}) => ({
    message: 'Import product report fetched.',
    period: {
      from,
      to,
      dateField: sourceOverrides.dateColumn ? `cargo.${sourceOverrides.dateColumn}` : null,
    },
    filters: {
      productCategory: {
        key: productCategoryKey,
        label: '',
      },
      excludeAssortedCategories: true,
    },
    limits: {
      categoryLimit,
      clientLimit,
      topImporterLimit,
    },
    summary: {
      totalImports: 0,
      uniqueClients: 0,
      uniqueCategories: 0,
      totalUnits: 0,
      latestImportAt: '',
      topClientName: '',
      categoryTotalCbm: 0,
    },
    topImporters: [],
    categoryOptions: [],
    categoryBreakdown: [],
    clientCategoryRows: [],
    trend: emptyTrend,
    sources: {
      dateColumn: sourceOverrides.dateColumn || null,
      datasetMode: sourceOverrides.datasetMode || null,
      categorySourceAvailable: Boolean(sourceOverrides.categorySourceAvailable),
      excludeAssortedCategories: true,
      missingSources: [...new Set(missingSources)],
    },
    rowCounts: {
      returnedClientCategoryRows: 0,
      totalClientCategoryRows: 0,
    },
  });

  if (!await tableExists('cargo')) {
    return emptyReport(['cargo']);
  }

  const cargoIdCol = await pickColumn('cargo', ['cargoid', 'id']);
  const cargoClientCol = await pickColumn('cargo', ['userid', 'clientid']);
  const cargoDateCol = await pickColumn('cargo', ['cargocreatedon', 'created_on', 'created_at', 'createdon']);
  const cargoPackagesCol = await pickColumn('cargo', ['packages']);
  const cargoContentCol = await pickColumn('cargo', ['content']);
  const cargoVolumeCol = await pickColumn('cargo', ['volume', 'cbm']);
  const missingSources = [];

  if (!cargoIdCol) missingSources.push('cargo.cargoid');
  if (!cargoClientCol) missingSources.push('cargo.userid');
  if (!cargoDateCol) missingSources.push('cargo.cargocreatedon');
  if (!cargoVolumeCol) missingSources.push('cargo.volume');
  if (!cargoIdCol || !cargoClientCol || !cargoDateCol) {
    return emptyReport(missingSources, { dateColumn: cargoDateCol });
  }

  const cargoId = qid(cargoIdCol);
  const cargoClient = qid(cargoClientCol);
  const cargoDate = qid(cargoDateCol);
  let fromSql = 'FROM `cargo` cg';
  const whereSqlText = `WHERE cg.${cargoDate} >= ? AND cg.${cargoDate} <= ?`;
  let clientNameExpr = `CONCAT('Client #', COALESCE(cg.${cargoClient}, 0))`;

  let clientsAvailable = false;
  if (await tableExists('Clients')) {
    const clientIdCol = await pickColumn('Clients', ['userid', 'id']);
    const clientFirstCol = await pickColumn('Clients', ['firstname', 'first_name']);
    const clientLastCol = await pickColumn('Clients', ['lastname', 'last_name']);
    const clientBusinessCol = await pickColumn('Clients', ['business']);
    if (clientIdCol) {
      clientsAvailable = true;
      fromSql += ` LEFT JOIN \`Clients\` cl ON cl.${qid(clientIdCol)} = cg.${cargoClient}`;
      const nameParts = [];
      if (clientFirstCol) nameParts.push(`COALESCE(cl.${qid(clientFirstCol)}, '')`);
      if (clientLastCol) nameParts.push(`COALESCE(cl.${qid(clientLastCol)}, '')`);
      const fullNameExpr = nameParts.length > 0
        ? `NULLIF(TRIM(CONCAT(${nameParts.join(", ' ', ")})), '')`
        : 'NULL';
      const businessExpr = clientBusinessCol
        ? `NULLIF(TRIM(cl.${qid(clientBusinessCol)}), '')`
        : 'NULL';
      clientNameExpr = `COALESCE(${fullNameExpr}, ${businessExpr}, CONCAT('Client #', COALESCE(cg.${cargoClient}, 0)))`;
    }
  }
  if (!clientsAvailable) {
    missingSources.push('Clients.userid');
  }

  let categoryExpr = "'Uncategorized'";
  let quantityExpr = cargoPackagesCol ? `COALESCE(cg.${qid(cargoPackagesCol)}, 0)` : '1';
  let datasetMode = 'cargo_only';
  let categorySourceAvailable = false;

  if (await tableExists('cargo_packages')) {
    const cpCargoCol = await pickColumn('cargo_packages', ['cargo_id', 'cargoid']);
    const cpQtyCol = await pickColumn('cargo_packages', ['quantity', 'qty', 'packages']);
    const cpContentIdCol = await pickColumn('cargo_packages', ['content_id']);
    const cpContentCol = await pickColumn('cargo_packages', ['content']);
    const cpPackageTypeCol = await pickColumn('cargo_packages', ['package_type']);
    if (cpCargoCol) {
      datasetMode = 'packages';
      const cpCargo = qid(cpCargoCol);
      fromSql += ` LEFT JOIN \`cargo_packages\` cp ON cp.${cpCargo} = cg.${cargoId}`;

      const categoryParts = [];
      if (await tableExists('cargo_content_category') && cpContentIdCol) {
        const catIdCol = await pickColumn('cargo_content_category', ['id']);
        const catContentCol = await pickColumn('cargo_content_category', ['content']);
        if (catIdCol && catContentCol) {
          fromSql += ` LEFT JOIN \`cargo_content_category\` cat ON cat.${qid(catIdCol)} = cp.${qid(cpContentIdCol)}`;
          categoryParts.push(`NULLIF(TRIM(cat.${qid(catContentCol)}), '')`);
          categorySourceAvailable = true;
        }
      }
      if (cpContentCol) {
        categoryParts.push(`NULLIF(TRIM(cp.${qid(cpContentCol)}), '')`);
        categorySourceAvailable = true;
      }
      if (cpPackageTypeCol) {
        categoryParts.push(`NULLIF(TRIM(cp.${qid(cpPackageTypeCol)}), '')`);
        categorySourceAvailable = true;
      }
      if (categoryParts.length === 0 && cargoContentCol) {
        categoryParts.push(`NULLIF(TRIM(cg.${qid(cargoContentCol)}), '')`);
        categorySourceAvailable = true;
      }
      if (categoryParts.length > 0) {
        categoryExpr = `COALESCE(${categoryParts.join(', ')}, 'Uncategorized')`;
      }

      if (cpQtyCol) {
        quantityExpr = cargoPackagesCol
          ? `CASE WHEN cp.${cpCargo} IS NULL THEN COALESCE(cg.${qid(cargoPackagesCol)}, 0) ELSE COALESCE(cp.${qid(cpQtyCol)}, 0) END`
          : `COALESCE(cp.${qid(cpQtyCol)}, 0)`;
      } else if (cargoPackagesCol) {
        quantityExpr = `COALESCE(cg.${qid(cargoPackagesCol)}, 0)`;
      }
    } else {
      missingSources.push('cargo_packages.cargo_id');
    }
  }

  if (datasetMode === 'cargo_only' && await tableExists('cargoitems')) {
    const ciCargoCol = await pickColumn('cargoitems', ['cargoid', 'cargo_id']);
    const ciCategoryCol = await pickColumn('cargoitems', ['category', 'content']);
    const ciQtyCol = await pickColumn('cargoitems', ['quantity', 'qty']);
    if (ciCargoCol && ciCategoryCol) {
      datasetMode = 'cargoitems';
      fromSql += ` LEFT JOIN \`cargoitems\` ci ON ci.${qid(ciCargoCol)} = cg.${cargoId}`;
      categoryExpr = `COALESCE(NULLIF(TRIM(ci.${qid(ciCategoryCol)}), ''), 'Uncategorized')`;
      categorySourceAvailable = true;
      quantityExpr = ciQtyCol
        ? `COALESCE(ci.${qid(ciQtyCol)}, 0)`
        : (cargoPackagesCol ? `COALESCE(cg.${qid(cargoPackagesCol)}, 0)` : '1');
    }
  }

  if (!categorySourceAvailable && cargoContentCol) {
    categoryExpr = `COALESCE(NULLIF(TRIM(cg.${qid(cargoContentCol)}), ''), 'Uncategorized')`;
    categorySourceAvailable = true;
  }
  if (!categorySourceAvailable) {
    missingSources.push('cargo category source (cargo_packages/cargo_content_category/cargoitems)');
  }

  const clientIdExpr = `COALESCE(cg.${cargoClient}, 0)`;
  const cbmExpr = cargoVolumeCol ? `COALESCE(cg.${qid(cargoVolumeCol)}, 0)` : '0';
  const categoryWhereSqlText = categorySourceAvailable
    ? `${whereSqlText} AND LOWER(TRIM(${categoryExpr})) <> 'assorted'`
    : whereSqlText;

  const summaryRows = await queryRows(
    `SELECT COUNT(DISTINCT cg.${cargoId}) AS totalImports,
            COUNT(DISTINCT ${clientIdExpr}) AS uniqueClients,
            COALESCE(SUM(${quantityExpr}), 0) AS totalUnits,
            MAX(cg.${cargoDate}) AS latestImportAt
     ${fromSql}
     ${whereSqlText}`,
    [startSql, endSql]
  );
  const summary = {
    totalImports: Number(summaryRows[0]?.totalImports || 0),
    uniqueClients: Number(summaryRows[0]?.uniqueClients || 0),
    uniqueCategories: 0,
    totalUnits: Number(summaryRows[0]?.totalUnits || 0),
    latestImportAt: String(summaryRows[0]?.latestImportAt || ''),
    topClientName: '',
    categoryTotalCbm: 0,
  };

  let allCategoryMetrics = {
    categoryOptions: [],
    categoryBreakdown: [],
    clientCategoryRows: [],
    totalClientCategoryRows: 0,
    uniqueCategories: 0,
    categoryTotalCbm: 0,
  };
  let categoryMetrics = allCategoryMetrics;
  let selectedProductCategoryLabel = '';
  if (categorySourceAvailable) {
    const uniqueClientRows = await queryRows(
      `SELECT COUNT(DISTINCT ${clientIdExpr}) AS total
       ${fromSql}
       ${categoryWhereSqlText}`,
      [startSql, endSql]
    );
    summary.uniqueClients = Number(uniqueClientRows[0]?.total || 0);

    const categoryDetailRows = await queryRows(
      `SELECT cg.${cargoId} AS cargo_id,
              ${clientIdExpr} AS client_id,
              ${clientNameExpr} AS client_name,
              ${categoryExpr} AS category_label,
              ${quantityExpr} AS quantity_value,
              ${cbmExpr} AS cargo_cbm,
              cg.${cargoDate} AS latest_import_at
       ${fromSql}
       ${whereSqlText}`,
      [startSql, endSql]
    );
    allCategoryMetrics = buildImportProductCategoryMetrics(categoryDetailRows, '', 0, 0);
    categoryMetrics = productCategoryKey
      ? buildImportProductCategoryMetrics(categoryDetailRows, productCategoryKey, categoryLimit, clientLimit)
      : buildImportProductCategoryMetrics(categoryDetailRows, '', categoryLimit, clientLimit);
    summary.uniqueCategories = Number(allCategoryMetrics.uniqueCategories || 0);
    summary.categoryTotalCbm = Number(categoryMetrics.categoryTotalCbm || 0);
    selectedProductCategoryLabel = allCategoryMetrics.categoryOptions.find((option) => option.key === productCategoryKey)?.label || '';
  }

  const topClientRows = await queryRows(
    `SELECT t.client_name AS clientName,
            COALESCE(SUM(t.cargo_cbm), 0) AS totalCbm
     FROM (
       SELECT cg.${cargoId} AS cargo_id,
              ${clientIdExpr} AS client_id,
              ${clientNameExpr} AS client_name,
              ${cbmExpr} AS cargo_cbm
       ${fromSql}
       ${categoryWhereSqlText}
       GROUP BY cargo_id, client_id, client_name, cargo_cbm
     ) t
     GROUP BY t.client_id, t.client_name
     ORDER BY totalCbm DESC, t.client_name ASC
     LIMIT 1`,
    [startSql, endSql]
  );
  summary.topClientName = String(topClientRows[0]?.clientName || '');

  const topImporterRows = await queryRows(
    `SELECT t.client_id AS clientId,
            t.client_name AS clientName,
            COUNT(*) AS cargoCount,
            COALESCE(SUM(t.cargo_cbm), 0) AS totalCbm,
            COALESCE(AVG(t.cargo_cbm), 0) AS averageCbm
     FROM (
       SELECT cg.${cargoId} AS cargo_id,
              ${clientIdExpr} AS client_id,
              ${clientNameExpr} AS client_name,
              ${cbmExpr} AS cargo_cbm
       ${fromSql}
       ${categoryWhereSqlText}
       GROUP BY cargo_id, client_id, client_name, cargo_cbm
     ) t
     GROUP BY t.client_id, t.client_name
     ORDER BY totalCbm DESC, averageCbm DESC, t.client_name ASC
     LIMIT ${topImporterLimit}`,
    [startSql, endSql]
  );
  const topImporters = topImporterRows.map((row) => ({
    clientId: Number(row.clientId || 0),
    clientName: String(row.clientName || '').trim() || 'Unknown client',
    cargoCount: Number(row.cargoCount || 0),
    totalCbm: Number(row.totalCbm || 0),
    averageCbm: Number(row.averageCbm || 0),
  }));

  const dailyRows = await queryRows(
    `SELECT DATE(cg.${cargoDate}) AS dayKey,
            COUNT(DISTINCT cg.${cargoId}) AS total
     FROM \`cargo\` cg
     WHERE cg.${cargoDate} >= ?
       AND cg.${cargoDate} <= ?
     GROUP BY DATE(cg.${cargoDate})
     ORDER BY DATE(cg.${cargoDate}) ASC`,
    [startSql, endSql]
  );
  const dailyCounts = {};
  for (const row of dailyRows) {
    if (row.dayKey) {
      dailyCounts[String(row.dayKey)] = Number(row.total || 0);
    }
  }

  return {
    message: 'Import product report fetched.',
    period: {
      from,
      to,
      dateField: `cargo.${cargoDateCol}`,
    },
    filters: {
      productCategory: {
        key: productCategoryKey,
        label: selectedProductCategoryLabel,
      },
      excludeAssortedCategories: true,
    },
    limits: {
      categoryLimit,
      clientLimit,
      topImporterLimit,
    },
    summary,
    topImporters,
    categoryOptions: categorySourceAvailable ? allCategoryMetrics.categoryOptions : [],
    categoryBreakdown: categoryMetrics.categoryBreakdown,
    clientCategoryRows: categoryMetrics.clientCategoryRows,
    trend: buildImportProductTrend(from, to, dailyCounts),
    sources: {
      dateColumn: cargoDateCol,
      datasetMode,
      categorySourceAvailable,
      excludeAssortedCategories: true,
      missingSources: [...new Set(missingSources)],
    },
    rowCounts: {
      returnedClientCategoryRows: categoryMetrics.clientCategoryRows.length,
      totalClientCategoryRows: categoryMetrics.totalClientCategoryRows,
    },
  };
}

function buildImportProductCategoryMetrics(rows, selectedCategoryKey = '', categoryLimit = 0, clientLimit = 0) {
  const cargoGroups = new Map();
  const categoryOptions = new Map();

  for (const row of rows) {
    const cargoId = Number(row.cargo_id || 0);
    if (cargoId <= 0) {
      continue;
    }

    const categoryLabel = importProductCategoryLabel(row.category_label);
    const categoryKey = importProductCategoryKey(categoryLabel);
    if (categoryKey === 'assorted') {
      continue;
    }
    if (!categoryOptions.has(categoryKey)) {
      categoryOptions.set(categoryKey, categoryLabel);
    }

    if (!cargoGroups.has(cargoId)) {
      const clientName = String(row.client_name || '').trim();
      cargoGroups.set(cargoId, {
        clientId: Number(row.client_id || 0),
        clientName: clientName || 'Unknown client',
        cargoCbm: Math.max(0, Number(row.cargo_cbm || 0)),
        latestImportAt: String(row.latest_import_at || ''),
        categories: new Map(),
      });
    } else {
      const cargo = cargoGroups.get(cargoId);
      if (isImportProductMoreRecent(row.latest_import_at, cargo.latestImportAt)) {
        cargo.latestImportAt = String(row.latest_import_at || '');
      }
    }

    const cargo = cargoGroups.get(cargoId);
    if (!cargo.categories.has(categoryKey)) {
      cargo.categories.set(categoryKey, {
        label: categoryLabel,
        weight: 0,
      });
    }
    const category = cargo.categories.get(categoryKey);
    category.weight += importProductQuantityWeight(row.quantity_value);
  }

  const categoryTotals = new Map();
  const clientCategoryTotals = new Map();
  for (const [cargoId, cargo] of cargoGroups.entries()) {
    if (cargo.categories.size === 0) {
      continue;
    }
    let weightTotal = 0;
    for (const category of cargo.categories.values()) {
      weightTotal += Math.max(0, Number(category.weight || 0));
    }
    if (weightTotal <= 0) {
      weightTotal = cargo.categories.size;
      for (const category of cargo.categories.values()) {
        category.weight = 1;
      }
    }

    for (const [categoryKey, category] of cargo.categories.entries()) {
      if (selectedCategoryKey && selectedCategoryKey !== categoryKey) {
        continue;
      }
      const allocatedCbm = weightTotal > 0
        ? cargo.cargoCbm * (Number(category.weight || 0) / weightTotal)
        : 0;

      if (!categoryTotals.has(categoryKey)) {
        categoryTotals.set(categoryKey, {
          key: categoryKey,
          label: String(category.label || 'Uncategorized'),
          totalCbm: 0,
          cargoIds: new Set(),
        });
      }
      const categoryTotal = categoryTotals.get(categoryKey);
      categoryTotal.totalCbm += allocatedCbm;
      categoryTotal.cargoIds.add(cargoId);

      const clientCategoryKey = `${cargo.clientId}|${categoryKey}`;
      if (!clientCategoryTotals.has(clientCategoryKey)) {
        clientCategoryTotals.set(clientCategoryKey, {
          clientId: cargo.clientId,
          clientName: cargo.clientName,
          categoryKey,
          categoryLabel: String(category.label || 'Uncategorized'),
          totalCbm: 0,
          cargoIds: new Set(),
          latestImportAt: cargo.latestImportAt,
        });
      }
      const clientCategoryTotal = clientCategoryTotals.get(clientCategoryKey);
      clientCategoryTotal.totalCbm += allocatedCbm;
      clientCategoryTotal.cargoIds.add(cargoId);
      if (isImportProductMoreRecent(cargo.latestImportAt, clientCategoryTotal.latestImportAt)) {
        clientCategoryTotal.latestImportAt = cargo.latestImportAt;
      }
    }
  }

  let categoryTotalCbm = 0;
  for (const categoryTotal of categoryTotals.values()) {
    categoryTotalCbm += Number(categoryTotal.totalCbm || 0);
  }

  let categoryBreakdown = [...categoryTotals.values()].map((categoryTotal) => ({
    key: categoryTotal.key,
    label: categoryTotal.label,
    totalCbm: Number(categoryTotal.totalCbm || 0),
    cargoCount: categoryTotal.cargoIds.size,
    sharePercent: categoryTotalCbm > 0 ? Number(((Number(categoryTotal.totalCbm || 0) / categoryTotalCbm) * 100).toFixed(1)) : 0,
  }));
  categoryBreakdown.sort((left, right) => (
    Number(right.totalCbm || 0) - Number(left.totalCbm || 0)
    || Number(right.cargoCount || 0) - Number(left.cargoCount || 0)
    || String(left.label || '').localeCompare(String(right.label || ''), undefined, { sensitivity: 'base' })
  ));
  if (categoryLimit > 0) {
    categoryBreakdown = categoryBreakdown.slice(0, categoryLimit);
  }

  let clientCategoryRows = [...clientCategoryTotals.values()].map((entry) => ({
    clientId: Number(entry.clientId || 0),
    clientName: entry.clientName || 'Unknown client',
    categoryKey: entry.categoryKey,
    categoryLabel: entry.categoryLabel,
    cargoCount: entry.cargoIds.size,
    totalCbm: Number(entry.totalCbm || 0),
    latestImportAt: String(entry.latestImportAt || ''),
  }));
  clientCategoryRows.sort((left, right) => (
    importProductDateMillis(right.latestImportAt) - importProductDateMillis(left.latestImportAt)
    || String(left.clientName || '').localeCompare(String(right.clientName || ''), undefined, { sensitivity: 'base' })
    || String(left.categoryLabel || '').localeCompare(String(right.categoryLabel || ''), undefined, { sensitivity: 'base' })
  ));
  const totalClientCategoryRows = clientCategoryRows.length;
  if (clientLimit > 0) {
    clientCategoryRows = clientCategoryRows.slice(0, clientLimit);
  }

  const categoryOptionRows = [...categoryOptions.entries()]
    .map(([key, label]) => ({ key, label }))
    .sort((left, right) => String(left.label || '').localeCompare(String(right.label || ''), undefined, { sensitivity: 'base' }));

  return {
    categoryOptions: categoryOptionRows,
    categoryBreakdown,
    clientCategoryRows,
    totalClientCategoryRows,
    uniqueCategories: categoryTotals.size,
    categoryTotalCbm,
  };
}

function importProductCategoryLabel(value) {
  const label = String(value || '').trim();
  return label || 'Uncategorized';
}

function importProductCategoryKey(value) {
  return importProductCategoryLabel(value).toLowerCase();
}

function importProductQuantityWeight(value) {
  const text = String(value ?? '').trim();
  if (!text) {
    return 1;
  }
  const numeric = Number(text);
  if (Number.isFinite(numeric)) {
    return numeric > 0 ? numeric : 1;
  }
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (match) {
    const parsed = Number(match[0]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  }
  return 1;
}

function isImportProductMoreRecent(candidate, current) {
  const candidateMillis = importProductDateMillis(candidate);
  if (candidateMillis <= 0) {
    return false;
  }
  const currentMillis = importProductDateMillis(current);
  return currentMillis <= 0 || candidateMillis > currentMillis;
}

function importProductDateMillis(value) {
  const text = String(value || '').trim();
  if (!text) {
    return 0;
  }
  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  const millis = Date.parse(normalized);
  return Number.isFinite(millis) ? millis : 0;
}

function buildImportProductTrend(startDate, endDate, dailyCounts) {
  const start = importProductDateOnly(startDate);
  const end = importProductDateOnly(endDate);
  const rangeDays = Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;
  const useMonthlyTrend = rangeDays > 31;
  const rows = [];
  let total = 0;

  if (useMonthlyTrend) {
    const monthCursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 1));
    const months = new Map();
    while (monthCursor < monthEnd) {
      const key = `${monthCursor.getUTCFullYear()}-${String(monthCursor.getUTCMonth() + 1).padStart(2, '0')}`;
      months.set(key, {
        date: key,
        label: importProductMonthLabel(monthCursor),
        count: 0,
      });
      monthCursor.setUTCMonth(monthCursor.getUTCMonth() + 1);
    }
    for (const [dayKey, count] of Object.entries(dailyCounts)) {
      const monthKey = String(dayKey).slice(0, 7);
      if (months.has(monthKey)) {
        months.get(monthKey).count += Math.max(0, Number(count || 0));
      }
    }
    for (const month of months.values()) {
      rows.push(month);
      total += Number(month.count || 0);
    }
  } else {
    const cursor = new Date(start.getTime());
    while (cursor <= end) {
      const date = importProductDateOnlyString(cursor);
      const count = Number(dailyCounts[date] || 0);
      rows.push({
        date,
        label: importProductDayLabel(cursor),
        count,
      });
      total += count;
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }

  return {
    groupBy: useMonthlyTrend ? 'monthly' : 'daily',
    total,
    rows,
  };
}

function importProductDateOnly(value) {
  return new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
}

function importProductDateOnlyString(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function importProductDayLabel(date) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

function importProductMonthLabel(date) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function reportPeriodExpression(dateExpression, groupBy = 'daily') {
  if (groupBy === 'monthly') {
    const expression = `DATE_FORMAT(${dateExpression}, '%Y-%m')`;
    return { select: expression, groupBy: expression };
  }
  if (groupBy === 'weekly') {
    const expression = `YEARWEEK(${dateExpression}, 1)`;
    return { select: expression, groupBy: expression };
  }
  const expression = `DATE(${dateExpression})`;
  return { select: expression, groupBy: expression };
}

async function loadOrderFormItems(orderId) {
  if (!await tableExists('order_form_items')) {
    return [];
  }
  return queryRows(
    `SELECT id AS itemId,
            order_form_id AS orderId,
            status,
            product_name AS productName,
            product_category_id AS productCategoryId,
            description,
            product_link AS productLink,
            size,
            quantity,
            unit_price AS unitPrice,
            product_value AS productValue,
            local_shipping AS localShipping,
            tracking_number AS trackingNumber,
            line_total AS lineTotal,
            photo_path AS photoPath,
            created_at AS createdAt
     FROM order_form_items
     WHERE order_form_id = ?
     ORDER BY id ASC`,
    [orderId]
  );
}

async function loadOrderFormStatusLogs(orderId) {
  if (!await tableExists('order_form_status_logs')) {
    return [];
  }
  return queryRows(
    `SELECT id AS logId,
            order_form_id AS orderId,
            status,
            note,
            changed_by AS changedBy,
            created_at AS createdAt
     FROM order_form_status_logs
     WHERE order_form_id = ?
     ORDER BY created_at ASC, id ASC`,
    [orderId]
  );
}

async function loadOrderFormPurchaseProofs(orderId) {
  if (!await tableExists('order_form_purchase_proofs')) {
    return [];
  }
  return queryRows(
    `SELECT id AS proofId,
            order_form_id AS orderId,
            order_form_item_id AS orderItemId,
            file_path AS filePath,
            original_name AS originalName,
            mime_type AS mimeType,
            file_size AS fileSize,
            uploaded_by AS uploadedBy,
            uploaded_by_name AS uploadedByName,
            created_at AS createdAt
     FROM order_form_purchase_proofs
     WHERE order_form_id = ?
     ORDER BY created_at DESC, id DESC`,
    [orderId]
  );
}

function reportDateRange(startDate, endDate) {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const defaultEnd = `${yyyy}-${mm}-${dd}`;
  const defaultStart = `${yyyy}-${mm}-01`;
  let start = startDate || defaultStart;
  let end = endDate || defaultEnd;
  if (start > end) {
    [start, end] = [end, start];
  }
  return { startDate: start, endDate: end };
}

async function loadTimesheetPolicy() {
  const defaults = {
    officialTimeIn: '08:00:00',
    officialTimeOut: '17:00:00',
    lunchMinutes: 90,
    maxDailyHours: 0,
  };
  if (!await tableExists('timesheet_policies')) {
    return defaults;
  }
  const rows = await queryRows(
    `SELECT official_time_in AS officialTimeIn,
            official_time_out AS officialTimeOut,
            lunch_minutes AS lunchMinutes,
            max_daily_hours AS maxDailyHours
     FROM timesheet_policies
     ORDER BY id DESC
     LIMIT 1`
  );
  return { ...defaults, ...(rows[0] || {}) };
}

async function loadTimesheetDailyRows({ employeeId, startDate, endDate, search, rowLimit }, policy) {
  const hasEmployee = await tableExists('employee');
  const where = ['DATE(te.event_time) >= ?', 'DATE(te.event_time) <= ?'];
  const params = [startDate, endDate];
  addEqual(where, params, 'te.employee_id', employeeId);
  if (search && hasEmployee) {
    where.push('(e.firstname LIKE ? OR e.lastname LIKE ? OR e.position LIKE ? OR e.department LIKE ?)');
    params.push(like(search), like(search), like(search), like(search));
  }

  const safeLimit = clampInt(rowLimit, 5000, 1, 5000);
  const rows = await queryRows(
    `SELECT te.employee_id AS employeeId,
            DATE(te.event_time) AS workDate,
            MIN(CASE WHEN te.action = 'clock_in' THEN te.event_time END) AS firstIn,
            MAX(CASE WHEN te.action = 'clock_out' THEN te.event_time END) AS lastOut,
            MIN(CASE WHEN te.action = 'clock_in' THEN te.location_name END) AS firstInLocation,
            MAX(CASE WHEN te.action = 'clock_out' THEN te.location_name END) AS lastOutLocation,
            COUNT(*) AS punchCount,
            SUM(CASE WHEN te.action = 'clock_in' THEN 1 ELSE 0 END) AS clockInCount,
            SUM(CASE WHEN te.action = 'clock_out' THEN 1 ELSE 0 END) AS clockOutCount,
            ${hasEmployee ? 'e.firstname' : 'NULL'} AS firstname,
            ${hasEmployee ? 'e.lastname' : 'NULL'} AS lastname,
            ${hasEmployee ? 'e.position' : 'NULL'} AS position,
            ${hasEmployee ? 'e.department' : 'NULL'} AS department
     FROM timesheet_entries te
     ${hasEmployee ? 'LEFT JOIN employee e ON e.employeeid = te.employee_id' : ''}
     ${whereSql(where)}
     GROUP BY te.employee_id, DATE(te.event_time), ${hasEmployee ? 'e.firstname, e.lastname, e.position, e.department' : 'te.employee_id'}
     ORDER BY workDate DESC, te.employee_id DESC
     LIMIT ${safeLimit}`,
    params
  );

  return rows.map((row) => {
    const employeeName = [row.firstname, row.lastname].filter(Boolean).join(' ').trim() || `Employee #${row.employeeId}`;
    const hours = calculateWorkedHours(row.firstIn, row.lastOut, Number(policy.lunchMinutes || 0), Number(policy.maxDailyHours || 0));
    const meta = timesheetStatus(row.workDate, row.firstIn, row.lastOut, policy.officialTimeIn, policy.officialTimeOut);
    return {
      employeeId: row.employeeId,
      employeeName,
      position: row.position,
      department: row.department,
      workDate: row.workDate,
      firstIn: row.firstIn,
      lastOut: row.lastOut,
      firstInLocation: row.firstInLocation,
      lastOutLocation: row.lastOutLocation,
      hours,
      punchCount: row.punchCount,
      clockInCount: row.clockInCount,
      clockOutCount: row.clockOutCount,
      ...meta,
    };
  });
}

function calculateWorkedHours(firstIn, lastOut, lunchMinutes, maxDailyHours) {
  const inTime = Date.parse(firstIn || '');
  const outTime = Date.parse(lastOut || '');
  if (!Number.isFinite(inTime) || !Number.isFinite(outTime) || outTime <= inTime) {
    return null;
  }
  const worked = Math.max(0, outTime - inTime - Math.max(0, lunchMinutes) * 60000) / 3600000;
  const capped = maxDailyHours > 0 ? Math.min(worked, maxDailyHours) : worked;
  return Number(capped.toFixed(2));
}

function timesheetStatus(workDate, firstIn, lastOut, officialIn, officialOut) {
  const firstMinutes = minutesOfDay(firstIn);
  const lastMinutes = minutesOfDay(lastOut);
  const officialInMinutes = timeToMinutes(officialIn || '08:00:00');
  const officialOutMinutes = timeToMinutes(officialOut || '17:00:00');
  const lateMinutes = firstMinutes === null ? 0 : Math.max(0, firstMinutes - officialInMinutes);
  const earlyMinutes = lastMinutes === null ? 0 : Math.max(0, officialOutMinutes - lastMinutes);
  const isLate = lateMinutes > 0;
  const isEarly = earlyMinutes > 0;
  let status = 'On time';
  if (!firstIn || !lastOut) status = 'Incomplete';
  else if (isLate && isEarly) status = 'Late & early';
  else if (isLate) status = 'Late in';
  else if (isEarly) status = 'Early out';
  return {
    status,
    isLate,
    isEarly,
    lateMinutes,
    earlyMinutes,
    workDate,
  };
}

function minutesOfDay(datetime) {
  if (!datetime) return null;
  const match = String(datetime).match(/\b(\d{2}):(\d{2})(?::\d{2})?\b/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function timeToMinutes(time) {
  const match = String(time || '').match(/^(\d{1,2}):(\d{2})/);
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

function summarizeTimesheetRows(rows) {
  const dashboard = {
    trackedDays: rows.length,
    completeDays: 0,
    workedHours: 0,
    lateOrEarlyDays: 0,
    incompleteDays: 0,
  };
  for (const row of rows) {
    if (row.hours !== null && row.hours !== undefined) {
      dashboard.workedHours += Number(row.hours || 0);
    }
    if (row.firstIn && row.lastOut) dashboard.completeDays++;
    if (row.isLate || row.isEarly) dashboard.lateOrEarlyDays++;
    if (row.status === 'Incomplete') dashboard.incompleteDays++;
  }
  dashboard.workedHours = Number(dashboard.workedHours.toFixed(2));
  dashboard.averageHoursPerCompleteDay = dashboard.completeDays > 0
    ? Number((dashboard.workedHours / dashboard.completeDays).toFixed(2))
    : 0;
  return dashboard;
}

function countBy(rows, key) {
  const counts = {};
  for (const row of rows) {
    const label = String(row[key] || 'Unspecified');
    counts[label] = (counts[label] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}

function buildTimesheetLeaderboard(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = String(row.employeeId);
    if (!map.has(key)) {
      map.set(key, {
        employeeId: row.employeeId,
        employeeName: row.employeeName,
        hours: 0,
        days: 0,
        onTimeDays: 0,
        lateOrEarlyDays: 0,
      });
    }
    const item = map.get(key);
    item.days += 1;
    item.hours += Number(row.hours || 0);
    if (row.status === 'On time') item.onTimeDays += 1;
    if (row.isLate || row.isEarly) item.lateOrEarlyDays += 1;
  }
  return [...map.values()]
    .map((row) => ({
      ...row,
      hours: Number(row.hours.toFixed(2)),
      onTimeRate: row.days > 0 ? Number(((row.onTimeDays / row.days) * 100).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.hours - a.hours || b.days - a.days);
}

function buildTimesheetExceptionCounts(rows) {
  const counts = {};
  for (const row of rows) {
    const reasons = [];
    if (row.status === 'Incomplete') reasons.push('Incomplete punch record');
    if (row.status === 'Late & early') reasons.push('Late in and early out on same day');
    if (Number(row.lateMinutes || 0) >= 30) reasons.push('Late in by 30+ minutes');
    if (Number(row.earlyMinutes || 0) >= 30) reasons.push('Early out by 30+ minutes');
    if (row.hours !== null && Number(row.hours) < 6) reasons.push('Worked under 6 hours');
    if (row.hours !== null && Number(row.hours) > 12) reasons.push('Worked over 12 hours');
    for (const reason of reasons) {
      counts[reason] = (counts[reason] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}

async function loadLeaveWorkflowSummary(range, employeeId) {
  if (!await tableExists('leave_applications')) {
    return null;
  }
  const where = ['la.submitted_at >= ?', 'la.submitted_at < DATE_ADD(?, INTERVAL 1 DAY)'];
  const params = [range.startDate, range.endDate];
  addEqual(where, params, 'la.employee_id', employeeId);
  const rows = await queryRows(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN la.status = 'approved' THEN 1 ELSE 0 END), 0) AS approved,
            COALESCE(SUM(CASE WHEN la.status = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected,
            COALESCE(SUM(CASE WHEN la.status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled,
            COALESCE(SUM(CASE WHEN la.status = 'pending' AND la.admin_status <> 'approved' THEN 1 ELSE 0 END), 0) AS pendingAdmin,
            COALESCE(SUM(CASE WHEN la.status = 'pending' AND la.admin_status = 'approved' AND la.management_status <> 'approved' THEN 1 ELSE 0 END), 0) AS pendingManagement
     FROM leave_applications la
     ${whereSql(where)}`,
    params
  );
  return rows[0] || {};
}

async function loadEarlyLateWorkflowSummary(range, employeeId) {
  if (!await tableExists('early_late_requests')) {
    return null;
  }
  const where = ['el.requested_at >= ?', 'el.requested_at < DATE_ADD(?, INTERVAL 1 DAY)'];
  const params = [range.startDate, range.endDate];
  addEqual(where, params, 'el.employee_id', employeeId);
  const rows = await queryRows(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN el.status = 'approved' THEN 1 ELSE 0 END), 0) AS approved,
            COALESCE(SUM(CASE WHEN el.status = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected,
            COALESCE(SUM(CASE WHEN el.status = 'pending' AND el.admin_status <> 'approved' THEN 1 ELSE 0 END), 0) AS pendingAdmin,
            COALESCE(SUM(CASE WHEN el.status = 'pending' AND el.admin_status = 'approved' AND el.management_status <> 'approved' THEN 1 ELSE 0 END), 0) AS pendingManagement,
            COALESCE(SUM(CASE WHEN el.emergency = 1 THEN 1 ELSE 0 END), 0) AS emergency
     FROM early_late_requests el
     ${whereSql(where)}`,
    params
  );
  return rows[0] || {};
}

function registerTool(name, config, handler) {
  server.registerTool(
    name,
    {
      ...config,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        ...(config.annotations || {}),
      },
    },
    async (args) => {
      try {
        const payload = await handler(args || {});
        return jsonResult({ ok: true, ...payload });
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );
}

function jsonResult(payload) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

async function requireTable(table) {
  if (!await tableExists(table)) {
    throw new Error(`Required table '${table}' was not found in the configured database.`);
  }
}

async function tableExists(table) {
  if (tableCache.has(table)) {
    return tableCache.get(table);
  }
  const rows = await queryRows(
    'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1',
    [table]
  );
  const exists = rows.length > 0;
  tableCache.set(table, exists);
  return exists;
}

async function resolveTable(candidates) {
  const key = candidates.join('|');
  if (resolvedTableCache.has(key)) {
    return resolvedTableCache.get(key);
  }

  for (const candidate of candidates) {
    if (await tableExists(candidate)) {
      resolvedTableCache.set(key, candidate);
      return candidate;
    }
  }

  for (const candidate of candidates) {
    const rows = await queryRows(
      'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) = LOWER(?) LIMIT 1',
      [candidate]
    );
    if (rows.length > 0) {
      const table = rows[0].TABLE_NAME;
      resolvedTableCache.set(key, table);
      return table;
    }
  }

  resolvedTableCache.set(key, null);
  return null;
}

async function tableColumns(table) {
  if (columnsCache.has(table)) {
    return columnsCache.get(table);
  }
  const rows = await queryRows(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [table]
  );
  const columns = new Set(rows.map((row) => row.COLUMN_NAME));
  columnsCache.set(table, columns);
  return columns;
}

async function hasColumn(table, column) {
  if (!await tableExists(table)) {
    return false;
  }
  const columns = await tableColumns(table);
  return columns.has(column);
}

async function queryRows(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return Array.isArray(rows) ? rows.map(cleanRow) : [];
}

async function connectionRows(conn, sql, params = []) {
  const [rows] = await conn.execute(sql, params);
  return Array.isArray(rows) ? rows.map(cleanRow) : [];
}

async function deleteRowsByColumn(conn, table, column, value) {
  if (!await tableExists(table)) {
    return { table, rows: 0, skipped: true };
  }
  if (!await hasColumn(table, column)) {
    return { table, rows: 0, skipped: true };
  }
  const [result] = await conn.execute(
    `DELETE FROM ${qid(table)} WHERE ${qid(column)} = ?`,
    [value]
  );
  return { table, rows: Number(result?.affectedRows || 0) };
}

async function databaseNow(conn) {
  const rows = await connectionRows(conn, 'SELECT NOW() AS now');
  return rows[0]?.now || new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function cleanRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (Buffer.isBuffer(value)) {
      out[key] = value.toString('utf8');
    } else {
      out[key] = value;
    }
  }
  return out;
}

function qid(identifier) {
  if (!/^[A-Za-z0-9_]+$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `\`${identifier}\``;
}

function addEqual(where, params, expression, value) {
  if (value === undefined || value === null || value === '') {
    return;
  }
  where.push(`${expression} = ?`);
  params.push(value);
}

function addLike(where, params, expression, value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return;
  }
  where.push(`${expression} LIKE ?`);
  params.push(like(value));
}

function addDateRange(where, params, expression, from, to) {
  if (from) {
    where.push(`${expression} >= ?`);
    params.push(from);
  }
  if (to) {
    where.push(`${expression} <= ?`);
    params.push(to);
  }
}

function like(value) {
  return `%${String(value).trim()}%`;
}

function whereSql(where) {
  return where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
}

function pagination(args) {
  return {
    limit: clampInt(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
    offset: clampInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

function withPagination(payload, limit, offset, total = null) {
  return {
    ...payload,
    pagination: {
      limit,
      offset,
      count: Array.isArray(payload.rows) ? payload.rows.length : null,
      total,
    },
  };
}

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const groupKey = String(row[key]);
    if (!map.has(groupKey)) {
      map.set(groupKey, []);
    }
    map.get(groupKey).push(row);
  }
  return map;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizeClientTextValue(value, field, options = {}) {
  const {
    allowNull = true,
    nonEmpty = false,
    maxLength = 500,
  } = options;
  const text = value === null || value === undefined ? '' : String(value).trim();
  if (nonEmpty && text === '') {
    throw new Error(`${field} cannot be blank.`);
  }
  if (text === '') {
    return allowNull ? null : '';
  }
  if (maxLength && text.length > maxLength) {
    throw new Error(`${field} must be ${maxLength} characters or fewer.`);
  }
  return text;
}

function clientFieldValuesEqual(currentValue, nextValue) {
  const normalize = (value) => {
    if (value === null || value === undefined) {
      return null;
    }
    const text = String(value).trim();
    return text === '' ? null : text;
  };
  return normalize(currentValue) === normalize(nextValue);
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ''));
}

function nullableInt(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number.parseInt(String(value), 10);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function emptyToNull(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return null;
  }
  return value;
}

function truncateText(value, maxLength) {
  const text = String(value || '');
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function capitalize(value) {
  const text = String(value || '');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function clampInt(value, fallback, min, max) {
  const number = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(Math.max(number, min), max);
}

const transport = new StdioServerTransport();
await server.connect(transport);

async function shutdown() {
  await server.close();
  await pool.end();
}

process.on('SIGINT', () => {
  shutdown().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  shutdown().finally(() => process.exit(0));
});
