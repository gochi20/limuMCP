# LIMU Portal MCP

Model Context Protocol server for LIMU Portal operational and finance data. Most tools are read-only; controlled write tools can update client records, purchase schedules, leave approvals, requisitions, and payment vouchers, and delete eligible requisitions or payment vouchers.

## Exposed Data

- Clients, including editable profile records plus cargo, package, shipment, invoice, payment, order-form, lead, KYC, query, and mobile-account summaries.
- Cargo records, tracking numbers, clients, shipment links, package totals, and cargo logs.
- Cargo package groups, package units, and stage-check summaries.
- Shipments, calendars, status updates, cargo totals, and budget summaries.
- Monthly budgets, detailed budget entries, and controlled purchase scheduling.
- Shipment customs budgets and shipping budgets, including income rows, expense rows, and budget logs.
- Requisitions, requisition items, payment vouchers, voucher items, payment proofs, and controlled approval/payment actions.
- Client profile reports, lead reports, order form reports, leave applications, and timesheet reports.

## Setup

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/limu/mcp
cp .env.example .env
npm install
npm run smoke
```

Use a least-privilege MySQL user. A read-only user is enough for reporting tools, but write tools need narrowly scoped `UPDATE` access for `Clients`, `monthly_budget_entry`, and `leave_applications`, `INSERT`/`UPDATE`/`DELETE` access for monthly budget schedule splits, `UPDATE`/`INSERT` access for leave logs, requisitions, requisition logs, payment vouchers, and budget spend tables, plus `DELETE` access for eligible requisitions, requisition items/logs, payment vouchers, voucher items, and voucher proof rows.
Write tools require `confirm: true`; use `dryRun: true` first to preview the exact proposed change.
Client auth secrets, token hashes, KYC link tokens, and government ID numbers are intentionally omitted from client tool responses.

## Run

```bash
cd /Applications/XAMPP/xamppfiles/htdocs/limu/mcp
npm start
```

Most MCP clients should launch it over stdio. Example client config:

```json
{
  "mcpServers": {
    "limu-portal": {
      "command": "node",
      "args": [
        "/Applications/XAMPP/xamppfiles/htdocs/limu/mcp/src/server.js"
      ],
      "env": {
        "LIMU_DB_HOST": "127.0.0.1",
        "LIMU_DB_PORT": "3306",
        "LIMU_DB_NAME": "limutradee",
        "LIMU_DB_USER": "root",
        "LIMU_DB_PASSWORD": ""
      }
    }
  }
}
```

## Tools

- `limu_health`
- `limu_get_clients`
- `limu_get_client`
- `limu_update_client`
- `limu_list_cargo`
- `limu_get_cargo`
- `limu_list_packages`
- `limu_get_package`
- `limu_list_shipments`
- `limu_get_shipment`
- `limu_list_monthly_budgets`
- `limu_get_monthly_budget`
- `limu_list_purchase_schedule`
- `limu_schedule_budget_purchase`
- `limu_list_shipment_budgets`
- `limu_get_shipment_budget`
- `limu_list_customs_budgets`
- `limu_get_customs_budget`
- `limu_list_shipping_budgets`
- `limu_get_shipping_budget`
- `limu_list_requisitions`
- `limu_get_requisition`
- `limu_review_requisition`
- `limu_delete_requisition`
- `limu_list_payment_vouchers`
- `limu_get_payment_voucher`
- `limu_review_payment_voucher`
- `limu_delete_payment_voucher`
- `limu_mark_payment_voucher_paid`
- `limu_list_client_profile_reports`
- `limu_get_client_profile_report`
- `limu_list_lead_reports`
- `limu_get_lead_report`
- `limu_list_order_form_reports`
- `limu_get_order_form_report`
- `limu_list_leave_applications`
- `limu_review_leave_application`
- `limu_list_timesheet_reports`
- `limu_list_warehouse_timesheet_reports`

All tools return JSON text payloads and list tools enforce a configurable `limit` cap.
