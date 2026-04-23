# NovaLink Operations Hub — S17/S18 Specification

> **Status:** DRAFT — Awaiting data samples before build
> **Last updated:** 2026-03-31
> **Prototypes:** `reference/production-hub/prototype.html` (S17), `reference/production-hub/bom-shortage-prototype.html` (S18)

---

## Vision

A single conversational operations hub where Luna acts as the communication bridge connecting order sources, production roles, inventory systems, and BOM management. The AI **does not make decisions** — it detects issues, computes options, presents them to humans, and executes only after explicit approval. Everything is public, traceable, and auditable.

---

## Design Principles

1. **AI as bridge, not decision-maker** — The bot surfaces issues and enforces accountability. It never autonomously overrides, approves, or modifies production data.
2. **Full traceability** — Every action logged with who, what, when, and from which source (Telegram, ERP, email, file upload, API).
3. **Public by default** — All stakeholders see all actions. Role-based notifications ensure the right people are alerted, but no information is hidden.
4. **Bilingual from day one** — EN/ES throughout, both conversational commands and dashboard UI.
5. **WO-scoped overrides only** — BOM exceptions never modify the master BOM. They are sandboxed to a single work order and auto-revert when the original material is restocked.

---

## Unified Dashboard Structure

One application, one sidebar, full traceability across S17 and S18:

```
NovaLink Operations Hub
├── Dashboard          KPIs + pipeline + alerts (S17+S18 combined)
├── Work Orders        Order table, status, progress tracking (S17)
├── BOM Manager        BOM lookup, revision tracking, override history (S18)
├── Inventory          On-hand snapshot from API, shortage alerts (S18)
├── FIFO Tracking      Split-order history and allocation (S18)
├── Bot / AI           Chat interface + intent reference (S17)
├── Activity Log       All actions from all sources (S17+S18)
└── Admin
    ├── Clients        Client profiles, terminology mapping (S17)
    └── API Config     BOM + Inventory API endpoints (S18)
```

Web UI served at `/hub` on the existing Luna web server (port 3030). Same authentication via `VOICE_WEB_TOKEN`. Real-time updates via WebSocket or 30-60 second auto-refresh.

---

## S17: Production Order Management

### Layer 1 — Order Ingestion (Multi-Source)

Orders arrive from 4 channels and are normalized into a single DB schema:

| Source | Format | How It Arrives |
|--------|--------|---------------|
| Client ERP | API access (structured) | Bot queries or receives webhook |
| Email | Message body with order details | Forwarded to bot or auto-parsed |
| Document | PDF, XLSX, DOCX attachment | Uploaded via Telegram or web |
| Verbal | Phone call or web conference | Transcribed via voice, confirmed by bot |

**The hard problem:** 10 active clients (up to 23 historically), each with different:
- Document formats (PDF layout, Excel column order, email structure)
- Vocabulary (Job = PartNumber OR Job = WorkOrder OR Style = PartNumber)
- Order structures (1 WO : 1 part, 1 WO : many parts, no WO — just part numbers)

**Solution approach:** Per-client mapping profiles defining:
- Terminology mapping (what they call each field)
- Document format expectations (which column/field maps to what)
- Order structure pattern (1:1, 1:many, or part-only)
- Part number format (regex pattern for validation)
- Internal WO auto-generation rules (when client doesn't provide one)

#### Pending Information
- [ ] **Current Excel template** — The blank spreadsheet everyone normalizes into today (defines target schema)
- [ ] **2-3 real order documents** (redacted) — Different clients, different formats, the messier the better
- [ ] **Email body example** — What an order-by-email actually looks like
- [ ] **Internal WO numbering convention** — Format (e.g., WO-YYYY-NNN) and who assigns
- [ ] **FG part number samples** — 20-30 real part numbers to understand the format pattern

### Layer 2 — Database Schema

```sql
-- Core order management
CREATE TABLE clients (
  id TEXT PRIMARY KEY,             -- e.g., "BU-042" or "ACME"
  name TEXT NOT NULL,
  terminology TEXT,                -- JSON: {"work_order": "PO", "part_number": "Style", ...}
  doc_format TEXT,                 -- JSON: parsing hints for this client's documents
  order_structure TEXT DEFAULT '1:1',  -- "1:1", "1:many", or "part-only"
  part_number_pattern TEXT,        -- Regex for validating their FG part numbers
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,             -- Internal: "ORD-NNNN" auto-generated
  client_id TEXT NOT NULL REFERENCES clients(id),
  client_ref TEXT,                 -- Client's own order/PO/WO reference (nullable)
  status TEXT NOT NULL DEFAULT 'queued',  -- queued, in_process, on_hold, completed, shipped
  priority TEXT NOT NULL DEFAULT 'medium', -- low, medium, high, urgent
  expected_ship TEXT,              -- ISO date
  destination TEXT,
  source TEXT NOT NULL,            -- "telegram", "email", "erp", "document", "voice"
  source_detail TEXT,              -- Who sent it, which file, etc.
  hold_reason TEXT,                -- If on_hold, why
  held_by TEXT,                    -- Who placed the hold
  held_at INTEGER,                 -- When
  notes TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id),
  fg_part_number TEXT NOT NULL,    -- Finished good part number
  description TEXT,
  qty_required INTEGER NOT NULL,
  qty_completed INTEGER DEFAULT 0,
  pct_done REAL GENERATED ALWAYS AS (
    CASE WHEN qty_required > 0 THEN ROUND(CAST(qty_completed AS REAL) / qty_required * 100, 1) ELSE 0 END
  ) STORED,
  eta TEXT,                        -- Updated ETA for this item
  status TEXT DEFAULT 'pending',   -- pending, in_process, on_hold, completed, shipped
  hold_reason TEXT,
  bom_revision TEXT,               -- Current BOM revision in use (S18)
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT REFERENCES orders(id),
  item_id INTEGER REFERENCES order_items(id),
  action TEXT NOT NULL,            -- "created", "priority_changed", "hold_placed", "hold_released",
                                   -- "progress_reported", "shipped", "bom_override", "bom_reverted"
  detail TEXT NOT NULL,            -- Human-readable description
  actor TEXT NOT NULL,             -- "planner", "supervisor", "materials", "bot", "client", username
  source TEXT NOT NULL,            -- "telegram", "web", "api", "email"
  created_at INTEGER DEFAULT (unixepoch())
);
```

### Layer 3 — Conversational Intent Classification

The bot classifies every message into one of these intents:

| Intent | Example (EN) | Example (ES) | DB Action |
|--------|-------------|-------------|-----------|
| **Priority Control** | "Set ORD-2847 above ORD-2851" | "Poner ORD-2847 antes de ORD-2851" | Update `orders.priority`, reorder queue |
| **Hold Management** | "Mark FG-PRN-0041 on hold due to fabric shortage" | "Poner en espera FG-PRN-0041 por falta de tela" | Set `status=on_hold`, `hold_reason`, notify Materials |
| **Progress Reporting** | "360 pcs complete on ORD-2847, ETA Apr 2" | "360 piezas completas en ORD-2847, para el 2 de abril" | Update `qty_completed`, recalculate `pct_done`, update ETA |
| **Release Commands** | "FL-1892 received, release holds" | "FL-1892 recibido, liberar órdenes en espera" | Query holds by material, bulk-release, notify all |
| **Status Queries** | "What's due before April 5?" | "¿Qué órdenes vencen antes del 5 de abril?" | SQL query → formatted response |
| **Order Ingestion** | "New order: 500 pcs FG-SHT-0234, priority HIGH, ship Apr 2" | "Nueva orden: 500 pzas FG-SHT-0234, prioridad ALTA, enviar 2 abril" | Insert to DB, notify Planner + Supervisor |
| **Disambiguation** | (bot asks) "Did you mean ORD-2847 or ORD-2848?" | (bot asks) "¿Te refieres a ORD-2847 o ORD-2848?" | Wait for confirmation before committing |

Implementation: Ollama tool `production_hub` with sub-actions matching each intent. The AI parses the natural language and calls the appropriate tool action with structured parameters.

### Layer 4 — Role-Based Notifications

Using native Telegram group chats (no separate notification system):

| Role | Telegram Group | Notified On |
|------|---------------|-------------|
| **Planner** | `Planners` group chat | New orders, priority changes, completion milestones, hold resolutions |
| **Supervisor** | `Supervisors` group chat | Priority changes, progress milestones, WO releases |
| **Materials Manager** | `Materials` group chat | Hold placements, material shortages, restock events |
| **Client** | Direct message or client group | Order status updates, shipping confirmations, approval requests |
| **All** | Broadcast to all groups | Major events (new orders, shipped orders) |

Configuration in `.env`:
```bash
HUB_PLANNER_CHAT_ID=group-chat-id
HUB_SUPERVISOR_CHAT_ID=group-chat-id
HUB_MATERIALS_CHAT_ID=group-chat-id
```

### Layer 5 — Dashboard (Web UI)

Served at `/hub`. Design language matches prototype (Inter + JetBrains Mono, dark/light theme, design tokens from prototype CSS).

**Dashboard page:**
- KPI strip: In-Process, Queued, Completed Today, On Hold, Shipped Today, Avg Lead Time
- Order Pipeline swimlanes (progress bars per order)
- Output chart (Chart.js bar chart, daily pcs)
- Active Holds panel
- Recent Bot Activity feed

**Orders page:**
- Searchable, filterable table (Order ID, FG Part #, Description, Qty, Progress, Priority, Status, Ship Date, Destination)
- Color-coded badges for status and priority

**Bot / AI page:**
- Embedded chat panel (connected to Luna via WebSocket)
- Intent reference cards showing example commands and expected outcomes
- Quick command buttons

**Activity Log page:**
- Full audit trail with source tracking

---

## S18: BOM & Shortage Intelligence

Builds on top of S17's order management. Adds BOM awareness, inventory monitoring, and shortage resolution.

### External API Integration

Two APIs already exist and are accessible:

**BOM API:**
- Input: FG part number
- Output: Component list (RM part numbers, quantities per unit, descriptions)
- Format: JSON response (option 1) or SQL query returning CSV (option 2)
- Start with: Option 2 (SQL/CSV) — available first

**Inventory API:**
- Input: Client ID → returns full on-hand inventory; or Client ID + RM part number → specific item
- Output: RM part numbers with on-hand quantities
- Format: JSON response (option 1) or SQL query returning CSV (option 2)
- Start with: Option 2 (SQL/CSV) — available first

Implementation: Two Ollama tools — `bom_lookup` and `inventory_check`. These wrap the API calls and return structured data to the AI.

#### Pending Information
- [ ] **BOM API sample response** — JSON or CSV showing structure (part numbers, quantities, costs)
- [ ] **Inventory API sample response** — JSON or CSV showing on-hand quantities
- [ ] **API authentication** — How to authenticate (API key? OAuth? Basic auth?)
- [ ] **API endpoint URLs** — Or at least the base URL pattern

### Three Hard Rules

These are **non-negotiable** and enforced at the code level, not by AI judgment:

#### Rule 1: No Partial Withdrawals
If inventory is insufficient for a WO's BOM requirements, the entire WO goes ON HOLD. The warehouse cannot withdraw partial materials. The only resolution paths are:
- (a) Full inventory becomes available → auto-release
- (b) Approved BOM override with alternative component → release with new BOM
- (c) Approved split-order: WO-A uses existing inventory (original BOM), WO-B uses alternative (new BOM draft)

#### Rule 2: WO-Scoped Overrides Only
When an alternative component is approved:
- A new BOM revision is created as a **draft tied to that specific WO** (e.g., BOM v3.1 Draft for WO-1093-B)
- The **master BOM is never modified** — it remains the canonical version
- The "WO-Scoped Only" indicator appears on every override card in the UI
- The override is stored with: WO ID, original RM, replacement RM, approved by, approved at

#### Rule 3: Auto-Revert
When the original raw material is restocked (detected via inventory API polling or manual notification):
- All **future** WOs automatically use the canonical BOM (no action needed)
- **Existing** WOs that already received an approved override continue with that override (already in production)
- The bot notifies all roles: "RM-4471-BLK (Black Cotton Twill 60") restocked. Future WOs will use original BOM v1.4."

### Shortage Detection Workflow

```
Bot polls Inventory API (configurable interval: 15-60 min)
    │
    ▼
Compare on-hand vs BOM requirements for all active WOs
    │
    ▼
Shortage detected for RM-XXXX?
    │
    ├─ YES → Identify affected WOs
    │         │
    │         ▼
    │    Alert all roles via Telegram:
    │    "⚡ Shortage detected: RM-4471-BLK (Black Cotton Twill 60")
    │     is out of stock. 5 work orders affected."
    │         │
    │         ▼
    │    Dashboard shows: AI Alert Banner + affected WOs highlighted
    │         │
    │         ▼
    │    WAIT for human action (Planner/Client):
    │    ├─ "Use RM-4472-BLK instead for WO-1092" → Bot creates WO-scoped BOM draft
    │    ├─ "Split WO-1093: 320 with existing, rest with alt" → Bot computes FIFO split
    │    ├─ "Hold all affected WOs" → Bot places holds, notifies warehouse
    │    └─ (No action) → WOs remain on hold, reminder sent after configurable interval
    │
    └─ NO → Continue monitoring
```

### Alternative Component Resolution

The bot does NOT autonomously select alternatives. The flow is:

1. **Bot detects** shortage and identifies affected WOs
2. **Bot presents** the shortage to Planner/Client with context (which WOs, how many units affected, current inventory snapshot)
3. **Human tells bot** what alternative to use: "Use RM-4472-BLK instead for WO-1092"
4. **Bot computes** the impact: cost delta per unit, total cost change, coverage (does the alternative have enough inventory?)
5. **Bot presents** the computed option with all data for approval
6. **Human approves or rejects** via Telegram buttons or commands
7. **If approved:** Bot creates WO-scoped BOM draft, notifies warehouse, logs everything
8. **If rejected:** WO remains on hold, logged as rejected with reason

Future enhancement: Build a rules engine for known substitutions (e.g., "RM-4472-BLK is always an acceptable alternative for RM-4471-BLK for Client BU-042"). This makes step 2 smarter by suggesting options, but the human still approves.

### FIFO Split-Order Computation

When partial inventory exists:

1. **Bot calculates** how much of the WO can be fulfilled with existing inventory (FIFO: use oldest stock first)
2. **Bot proposes** split: WO-1093-A (320 units, original BOM v3.0, Ready) + WO-1093-B (480 units, alt BOM v3.1 Draft, Needs approval)
3. **Human approves** the split via "Approve Split & BOM Draft" or "Set Entire WO On Hold"
4. **If approved:** Two sub-WOs created, each with correct BOM version. Warehouse gets both pick lists. Original WO marked as split.

### Approval Chain

```
Override proposal generated by bot
    │
    ▼
Notification sent to: Planner + Client + Supervisor + Materials
    │
    ▼
Client has precedence to approve/reject
    │
    ├─ Client responds → Decision logged, action taken
    │
    └─ Client not responding (configurable timeout) →
         Planner can approve/reject as fallback
         │
         └─ Decision logged with: "Approved by Planner (Client timeout)"
```

All parties are notified of both the proposal AND the approval/rejection regardless of who acted.

### Database Schema (S18 additions)

```sql
-- BOM management
CREATE TABLE bom_master (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fg_part_number TEXT NOT NULL,
  version TEXT NOT NULL,           -- e.g., "v1.4"
  components TEXT NOT NULL,        -- JSON array: [{rm_part: "RM-4471-BLK", qty_per_unit: 2.4, unit: "yds", cost: 3.20}, ...]
  is_current INTEGER DEFAULT 1,   -- Only one version is current per FG part
  source TEXT DEFAULT 'api',      -- "api" or "manual"
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE bom_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id),
  item_id INTEGER REFERENCES order_items(id),
  wo_number TEXT NOT NULL,         -- Specific WO this override applies to
  base_bom_version TEXT NOT NULL,  -- Original BOM version being overridden
  draft_version TEXT NOT NULL,     -- WO-scoped draft version (e.g., "v3.1-draft-WO-1093-B")
  original_rm TEXT NOT NULL,       -- RM being replaced
  replacement_rm TEXT NOT NULL,    -- Alternative RM
  qty_per_unit REAL,
  cost_delta REAL,                 -- Per-unit cost difference
  reason TEXT NOT NULL,            -- "material_shortage", "client_request", etc.
  status TEXT DEFAULT 'pending',   -- pending, approved, rejected, reverted
  proposed_by TEXT DEFAULT 'bot',
  approved_by TEXT,                -- Who approved (planner name or "client")
  approved_at INTEGER,
  reverted_at INTEGER,             -- When auto-revert happened (if applicable)
  revert_reason TEXT,              -- "original_rm_restocked"
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE shortage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  rm_part_number TEXT NOT NULL,
  rm_description TEXT,
  qty_on_hand INTEGER DEFAULT 0,
  qty_required INTEGER NOT NULL,   -- Total across all affected WOs
  affected_wo_count INTEGER,
  status TEXT DEFAULT 'active',    -- active, resolved, overridden
  resolved_at INTEGER,
  resolution TEXT,                 -- "restocked", "alternative_approved", "split_approved", "manual_hold"
  created_at INTEGER DEFAULT (unixepoch())
);

-- Inventory snapshots (cached from API)
CREATE TABLE inventory_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  rm_part_number TEXT NOT NULL,
  rm_description TEXT,
  qty_on_hand INTEGER NOT NULL,
  is_alternative INTEGER DEFAULT 0, -- Flag for known alternative components
  fetched_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(client_id, rm_part_number)  -- Upsert pattern
);
```

---

## Implementation Plan

### Phase 1: Foundation (S17-Core)
- [ ] DB schema (orders, items, activity log, clients)
- [ ] `production_hub` Ollama tool (create_order, update_priority, place_hold, release_hold, report_progress, query_status)
- [ ] `/hub` Telegram command (order list, status, quick actions)
- [ ] Activity logging on every action
- [ ] Role-based Telegram group notifications

### Phase 2: Order Ingestion (S17-Ingestion)
- [ ] Document parsing with per-client profiles (BLOCKED: waiting for sample documents)
- [ ] Client terminology mapping engine
- [ ] Auto-WO-number generation (BLOCKED: waiting for numbering convention)
- [ ] FG part number validation (BLOCKED: waiting for part number samples)
- [ ] File upload → parse → confirm → insert workflow

### Phase 3: Dashboard (S17-UI)
- [ ] Dashboard page (KPIs, pipeline, activity feed, holds)
- [ ] Orders page (table with search, filter, status badges)
- [ ] Bot/AI page (chat panel, intent reference)
- [ ] Activity Log page (full audit trail)
- [ ] Dark/light theme matching prototype design language

### Phase 4: BOM & Inventory Integration (S18-Core)
- [ ] BOM API connector tool (BLOCKED: waiting for API sample)
- [ ] Inventory API connector tool (BLOCKED: waiting for API sample)
- [ ] BOM master table populated from API
- [ ] Inventory cache with configurable refresh interval
- [ ] Shortage detection engine (compare BOM requirements vs inventory)

### Phase 5: Shortage Resolution (S18-Intelligence)
- [ ] Shortage event detection and alerting
- [ ] Alternative component suggestion (human-proposed, bot-computed)
- [ ] FIFO split-order computation
- [ ] WO-scoped BOM override creation (draft)
- [ ] Approval workflow (Client precedence → Planner fallback)
- [ ] Auto-revert on restock detection
- [ ] Override audit trail (who approved, when, why)

### Phase 6: Extended Dashboard (S18-UI)
- [ ] BOM Manager page (lookup, revision history, override log)
- [ ] Inventory page (on-hand snapshot, shortage alerts)
- [ ] FIFO Tracking page (split-order history)
- [ ] AI Suggestion panels (alternative component + split-order cards)
- [ ] BOM Revision Workflow pipeline visualization (8-step)
- [ ] "WO-Scoped Only" pill on all override UI elements

---

## Pending Information (blocks build)

| Item | Needed For | Status |
|------|-----------|--------|
| Current Excel template (blank) | S17 schema validation | Pending from team |
| 2-3 real order documents (redacted) | S17 parsing logic | Pending from team |
| Email body order example | S17 email ingestion | Pending from team |
| Internal WO numbering convention | S17 auto-generation | Pending from team |
| FG part number samples (20-30) | S17 validation regex | Pending from team |
| BOM API sample response (JSON or CSV) | S18 BOM tool | Pending — team getting access |
| Inventory API sample response | S18 inventory tool | Pending — team getting access |
| API authentication method | S18 API connectors | Pending from team |
| API endpoint URLs or patterns | S18 API connectors | Pending from team |

---

## Reference Materials

| File | Description |
|------|-------------|
| `reference/production-hub/prototype.html` | S17 Production Hub dashboard prototype (full HTML/CSS/JS) |
| `reference/production-hub/bom-shortage-prototype.html` | S18 BOM & Shortage Intelligence prototype |
| `reference/production-hub/chart.js` | Chart.js library used by prototypes |
| `reference/production-hub/css2` | Inter + JetBrains Mono font definitions |

---

## Non-Requirements (Explicitly Out of Scope)

- **No autonomous AI decisions** — Bot surfaces, computes, presents. Humans approve.
- **No master BOM mutation** — Overrides are always WO-scoped drafts. The canonical BOM is sacred.
- **No partial warehouse withdrawals** — If materials are insufficient, full WO hold. No exceptions without approved override.
- **No ERP write-back** (initially) — Read from external APIs, write to local DB only. ERP sync is a future enhancement.
- **No client self-service portal** (initially) — Clients interact via Telegram or existing channels. A web portal for clients is a future enhancement.
