# One-Click Install Roadmap

## Goal

Build a "near one-click" flow for end users:
1. Buy template.
2. Open Discord template URL and create server skeleton.
3. Return to dashboard, choose guild.
4. Apply bot settings with one button.

Result: 1-2 user actions, all remaining setup is automated.

## Current Status

- Implemented:
  - Server template CRUD API.
  - Install API: `POST /api/guilds/:guildId/install-template`.
  - Discord template URL field in server template: `discordTemplateUrl`.
  - Editor APIs for messages, reaction roles, log channels.
  - Extended mode APIs for roles/categories/channels.
- Missing:
  - Storefront + purchase flow.
  - User panel with purchased templates.
  - Role-based access separation for admin and customer.
  - Preflight validation before install.
  - Install telemetry and resilient retry/idempotency.

## Product Flows

### Admin flow (internal panel)

- Create/edit template metadata (`name`, `description`, `discordTemplateUrl`).
- Configure:
  - Messages.
  - Reaction roles.
  - Log channels.
  - Optional advanced mode: roles/categories/channels.
- Publish template to storefront.

### Customer flow (public/user panel)

- Browse and buy template.
- Open `discordTemplateUrl` and create Discord server.
- Select created guild in panel.
- Click "Apply bot settings".

## Role Separation (required)

Role model:
- `admin`:
  - Full template management.
  - Publish/unpublish products.
  - View install logs and diagnostics.
- `customer`:
  - Access only purchased templates.
  - Install to guilds they can manage.
  - Manage post-install settings only for owned template installs.

Minimum backend tasks:
1. Add `role` field to user/session model.
2. Add route guards:
   - Admin-only: template editor APIs, product management APIs.
   - Customer-only: purchased templates endpoints.
3. Add ownership checks:
   - `customer` can install only templates in `UserTemplateAccess`.
4. Hide admin endpoints from customer UI.

## Delivery Plan

### Phase 1 (MVP)

1. Storefront + purchase records:
   - `GET /api/store/templates`
   - `POST /api/store/checkout`
   - `POST /api/store/webhook`
2. Customer panel:
   - "My templates"
   - Install wizard (Discord URL -> guild select -> install)
3. Install result contract:
   - Return counts/skipped/errors for messages/reaction roles/logs.

### Phase 2 (stability)

1. Preflight endpoint:
   - `POST /api/guilds/:guildId/install-template/check`
2. Optional sync helper:
   - Import guild channels/roles metadata for better hints.
3. Idempotent install:
   - Prevent duplicate apply on rapid repeated clicks.

### Phase 3 (scale)

1. Template versioning.
2. Install jobs history and support-friendly logs.
3. Metrics dashboard for conversion and install success.

## Definition of Done

The feature is complete when:
- A customer can buy a template and install it with a short wizard.
- The install succeeds reliably and reports actionable errors.
- Admin and customer permissions are clearly separated and enforced.

## Implemented API Baseline (MVP)

- Storefront and purchases:
  - `GET /api/store/templates`
  - `POST /api/store/checkout`
  - `GET /api/store/my-purchases`
  - `POST /api/store/webhook` (payment webhook skeleton; optional secret header `x-webhook-secret`)
  - `POST /api/admin/store/templates/upsert`
- Access control:
  - `GET /api/my/server-templates`
  - `POST /api/admin/template-access`
  - `DELETE /api/admin/template-access/:userId/:templateId`
- Install flow:
  - `POST /api/guilds/:guildId/install-template/check` (preflight)
  - `POST /api/guilds/:guildId/install-template` (detailed report)
- Role separation:
  - Session role: `admin`/`customer` from `ADMIN_DISCORD_IDS`
  - Admin-only: template editor + admin store + access management
  - Customer/admin: guild operations, purchases, my templates
