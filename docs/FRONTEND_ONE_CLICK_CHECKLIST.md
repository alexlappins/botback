# Frontend Checklist: Near One-Click Flow

This file is the exact frontend scope for the current backend.

## 1) Environment and auth

- Use API base (example): `http://localhost:3000`
- For dev frontend on `5173`, use proxy `/api -> 3000`.
- Always send API requests with cookies:
  - `fetch(..., { credentials: 'include' })`
- Login flow:
  - redirect to `GET /api/auth/discord`
  - after callback backend redirects to `FRONTEND_URL`
- User session data:
  - `GET /api/auth/me`
  - use `role` field (`admin` or `customer`) for routing/UI permissions.

## 2) Role-based UI split (required)

- `admin` UI:
  - full template editor (`/api/server-templates/*`)
  - store management (`/api/admin/store/*`)
  - template access management (`/api/admin/template-access/*`)
- `customer` UI:
  - storefront browse
  - checkout
  - my purchased templates
  - install wizard and post-install settings
- Do not expose admin pages/actions in customer layout.

## 3) Storefront and purchases (customer)

### Pages
- `/store`:
  - list products
  - button "Buy"
- `/my-templates`:
  - list templates the user can install
  - button "Install"
- `/my-purchases` (optional but recommended):
  - purchase history

### APIs
- `GET /api/store/templates`
  - render cards: name, description, `discordTemplateUrl`, price, currency
- `POST /api/store/checkout`
  - body: `{ templateId }`
  - on success show toast and refresh:
    - `GET /api/my/server-templates`
    - `GET /api/store/my-purchases`
- `GET /api/store/my-purchases`
- `GET /api/my/server-templates`

## 4) Install wizard (customer)

Create one page: `/install/:templateId`

### Step A: "Create server skeleton in Discord"
- Show template data and `discordTemplateUrl`.
- Button "Open Discord Template" (new tab).
- Text hint: user creates server in Discord first.

### Step B: "Select target guild"
- `GET /api/guilds`
- Show only returned guilds in select.

### Step C: "Preflight check"
- `POST /api/guilds/:guildId/install-template/check`
- body: `{ templateId }`
- Render:
  - warnings
  - missing channels/roles/messages/log channels from `checks`
- If warnings exist, allow user to continue with confirmation.

### Step D: "Apply bot settings"
- `POST /api/guilds/:guildId/install-template`
- body: `{ templateId }`
- Render detailed result:
  - `summary` counters
  - `skipped` lists
  - `warnings`
- Show clear success/fail state and retry button.

## 5) Post-install customer settings

For selected guild, keep simple UI blocks:
- Logs:
  - `GET /api/guilds/:guildId/logs`
  - `PATCH /api/guilds/:guildId/logs`
- Reaction roles:
  - `GET /api/guilds/:guildId/reaction-roles`
  - `POST /api/guilds/:guildId/reaction-roles`
  - `POST /api/guilds/:guildId/reaction-roles/remove`
- Channels/roles lookups:
  - `GET /api/guilds/:guildId/channels`
  - `GET /api/guilds/:guildId/roles`

## 6) Admin pages you must build

### A) Template editor (internal only)
- CRUD via `api/server-templates/*`
- include `discordTemplateUrl` field
- sections:
  - messages
  - reaction roles
  - log channels
  - optional advanced mode: roles/categories/channels

### B) Store management (internal only)
- upsert product card for template:
  - `POST /api/admin/store/templates/upsert`
  - body: `{ templateId, price, currency, isActive }`

### C) Access management (internal only)
- grant access:
  - `POST /api/admin/template-access`
  - body: `{ userId, templateId }`
- revoke access:
  - `DELETE /api/admin/template-access/:userId/:templateId`

## 7) Error handling requirements

- If API returns `401` -> redirect to login.
- If API returns `403` -> show "No permission".
- If API returns `400` with message:
  - show exact message in UI (do not hide backend reason).
- For install APIs:
  - always render `warnings` and `skipped` lists.

## 8) API contract snippets

### Checkout
```http
POST /api/store/checkout
Content-Type: application/json

{ "templateId": "uuid" }
```

### Preflight
```http
POST /api/guilds/:guildId/install-template/check
Content-Type: application/json

{ "templateId": "uuid" }
```

### Install
```http
POST /api/guilds/:guildId/install-template
Content-Type: application/json

{ "templateId": "uuid" }
```

## 9) Frontend done criteria

Frontend is considered done when:
- customer can buy template from storefront;
- customer sees purchased templates only;
- install wizard works end-to-end (Discord template link -> guild select -> check -> install);
- install result screen shows summary/skipped/warnings;
- admin/customer areas are separated by user role.

