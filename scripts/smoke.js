#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

function intEnv(name, fallback) {
  const value = Number.parseInt(String(process.env[name] ?? ''), 10);
  return Number.isFinite(value) ? value : fallback;
}

const pool = mysql.createPool({
  host: process.env.LIMU_DB_HOST || '127.0.0.1',
  port: intEnv('LIMU_DB_PORT', 3306),
  socketPath: process.env.LIMU_DB_SOCKET || undefined,
  user: process.env.LIMU_DB_USER || 'root',
  password: process.env.LIMU_DB_PASSWORD || '',
  database: process.env.LIMU_DB_NAME || 'limutradee',
  waitForConnections: true,
  connectionLimit: 1,
  decimalNumbers: true,
  dateStrings: true,
  charset: 'utf8mb4',
});

const tables = [
  'cargo',
  'cargo_packages',
  'shipment',
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

try {
  const [dbRows] = await pool.execute('SELECT DATABASE() AS databaseName, NOW() AS serverTime');
  const visibleTables = {};
  for (const table of tables) {
    const [rows] = await pool.execute(
      'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1',
      [table]
    );
    visibleTables[table] = rows.length > 0;
  }

  console.log(JSON.stringify({
    ok: true,
    database: dbRows[0] || null,
    visibleTables,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exitCode = 1;
} finally {
  await pool.end();
}
