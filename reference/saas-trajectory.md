# clauded SaaS Trajectory — Client Integration Platform

> Board of Directors strategic direction (2026-04-03)
> Supporting analysis for ROADMAP.md Phase 4

---

## Business Context

Novalink provides nearshoring manufacturing services. Clients send production orders through various channels (ERP, email, PDF, phone), and Novalink manages the manufacturing process from order receipt through production, quality control, and shipment.

**The opportunity:** clauded already handles internal order management, production tracking, and cross-department communication. Extending this to client-facing integrations transforms clauded from an internal operations tool into a **managed integration platform** — a revenue-generating service.

**The value proposition to clients:** "Connect your systems to Novalink's production floor. Submit orders from Shopify, receive real-time status updates, get proactive shortage alerts, approve BOM changes — all through the same AI platform your production team uses."

---

## Why This Is Viable

Three existing clauded capabilities make client integration realistic:

### 1. Declarative HTTP Tools (existing)

`src/forge/declarative-http.ts` enables REST API connections via markdown configuration — no TypeScript required. A Shopify integration is 12 lines of markdown dropped into a client pack.

### 2. Domain Packs (existing)

Per-client isolation is already architected. Each client gets their own `packs/client-name/` directory with tools, skills, and templates. Pack loading, capability injection, and intent scoring all work per-pack.

### 3. Auto-Generated Skills (core subsystem)

When a Planner processes a client's order workflow manually, clauded learns the pattern and offers to automate it. Each client's integration gets smarter over time without developer intervention.

---

## Client Integration Patterns

### Pattern A: Shopify / E-commerce API

**Flow:** Client's Shopify store → clauded pulls orders → normalizes to internal DB → production proceeds → clauded posts shipment confirmation back to Shopify.

**Implementation:** Two declarative HTTP tools in a client pack:
1. `shopify-pull-orders.md` — GET orders by status
2. `shopify-post-shipment.md` — POST tracking info when shipped

**Complexity:** Low. Standard REST API. 1-2 days to set up per client.

### Pattern B: Client ERP API

**Flow:** Client's ERP system → clauded pulls/receives order data → normalizes fields (their PO# → our WO#, their Style → our FG Part#) → production proceeds → clauded pushes status updates back.

**Implementation:** Declarative HTTP tools + client pack with terminology mapping in `pack.yaml`.

**Complexity:** Medium. Varies by ERP system (SAP, Oracle, NetSuite, custom). 1-2 weeks per client.

### Pattern C: EDI (X12 / EDIFACT)

**Flow:** Client sends EDI 850 (Purchase Order) → clauded parses → normalizes → production → clauded generates EDI 856 (Ship Notice) + EDI 810 (Invoice) → transmits back.

**Implementation:** EDI parser tools (Level 3 — TypeScript, not declarative HTTP). Reusable across all EDI clients.

**Common EDI documents for manufacturing:**
- **850** — Purchase Order (client → Novalink)
- **855** — Purchase Order Acknowledgment (Novalink → client)
- **856** — Ship Notice / ASN (Novalink → client)
- **810** — Invoice (Novalink → client)
- **997** — Functional Acknowledgment (bidirectional)

**Complexity:** High. X12 format is specialized. 2-3 weeks to build the parser, then 1-2 days per new EDI client.

### Pattern D: Webhook-Based (Real-Time)

**Flow:** Client's system pushes events to clauded (e.g., Shopify order webhook on new purchase) → clauded processes immediately → confirms receipt.

**Implementation:** Requires webhook ingestion endpoint in clauded's web server. Not yet built.

**Complexity:** Medium for the infrastructure, low per-client once built.

---

## Revenue Model

### Service Tiers

| Tier | What Client Gets | Setup Fee | Monthly Fee | Margin |
|------|-----------------|:---:|:---:|---|
| **Basic** | Order submission via Telegram, status updates | Free | Included in manufacturing contract | Relationship value |
| **Standard** | REST API integration (Shopify, ERP) — orders auto-ingested, shipments auto-posted | $2,000-5,000 | $500-1,500 | High — once built, maintenance is minimal |
| **Premium** | Full EDI + BOM visibility + shortage alerts + approval workflows | $5,000-15,000 | $2,000-5,000 | High — EDI parser is reusable |
| **Custom** | Dedicated pack with client-specific automation, reporting, dashboards | $10,000-25,000 | $3,000-8,000 | Medium — requires development time |

### Revenue Projections

| Timeline | Clients | Mix | Monthly Recurring |
|----------|:---:|---|:---:|
| Quarter 1 (pilot) | 1 | 1 Standard | $500-1,500 |
| Quarter 2 | 3 | 2 Standard + 1 Premium | $3,000-8,000 |
| Quarter 3 | 5 | 3 Standard + 2 Premium | $5,500-18,000 |
| Year 1 end | 8-10 | 5 Standard + 3 Premium + 2 Custom | $15,000-45,000/month |

Against infrastructure costs of $1,000-3,000/month (hosting + Anthropic accounts), this achieves positive margin by Quarter 2.

---

## Internal ROI (Pre-SaaS)

Even before client-facing SaaS, internal deployment generates measurable returns:

### Time Savings

| Role | Current Process | With clauded | Hours Saved/Day | Annual Value (×$20/hr×260 days) |
|------|----------------|-------------|:---:|:---:|
| Data Collector (×5) | Paper forms → Excel entry | Voice input → auto-recorded | 2-3 hrs each | $52,000-78,000 |
| Production Planner (×2) | Excel priority juggling | Telegram command → instant | 1-2 hrs each | $10,400-20,800 |
| Material Handler (×4) | Walk to computer → check ERP | Telegram query → instant | 30-60 min each | $10,400-20,800 |
| Supervisor (×3) | Whiteboard + walk to office | Voice report → auto-logged | 1 hr each | $15,600 |
| Quality Engineer (×2) | Manual Cpk in Excel | `/sigma` → instant | 2-4 hrs per study | $8,000-16,000 |
| Production Engineer (×2) | Manual line balance in Excel | `/balance` → instant | 4-8 hrs per study | $8,000-16,000 |
| Financial Analyst (×1) | Manual budget variance | Upload CSV → instant report | 2-3 hrs per cycle | $4,000-6,000 |

**Conservative total: $108,000-174,000/year in labor reallocation.**

### Error Prevention

| Error Type | Current Frequency | Cost Per Incident | With clauded |
|-----------|:---:|:---:|---|
| Shortage detected late (line stops) | 2-4/month | $5,000-15,000 | Proactive alerts (S18) — detect hours earlier |
| BOM error (wrong materials picked) | 1-2/month | $2,000-8,000 | WO-scoped BOM with approval workflow (S18) |
| Priority conflict (wrong order produced first) | 3-5/month | $1,000-5,000 | Conversational priority management (S17) |
| Quality escape (defects shipped) | 1/quarter | $10,000-50,000 | SPC monitoring catches early (existing) |

**Conservative annual error prevention: $100,000-300,000.**

### Knowledge Preservation

When an experienced Planner or Engineer leaves, their tribal knowledge leaves with them. Auto-generated skills capture their workflows as reusable skills. New hire training time reduces from months to weeks.

**Estimated value: $20,000-50,000/year** (reduced training cost + fewer mistakes during onboarding).

---

## Technical Requirements (What's Needed)

### Already Available

| Capability | How It Works |
|---|---|
| REST API integration | Declarative HTTP tools in Domain Packs |
| Per-client isolation | Pack system with separate tools/skills/templates |
| Auto-learning | Auto-generated skills (core subsystem) |
| Production tracking | S17 Production Hub (in roadmap) |
| BOM/shortage management | S18 BOM Intelligence (in roadmap) |
| Bilingual support | EN/ES intent scoring + LANGUAGE_HINT |
| Document parsing | PDF, XLSX, DOCX, CSV (existing file parsers) |
| Notification routing | Telegram groups (role-based, existing) |
| Audit trail | Activity log (existing, extends in S17) |
| Security | Worker sandbox (SA1), policy engine (SA4), process separation (SA3) |

### Needs to Be Built

| Capability | Effort | Depends On |
|---|---|---|
| Webhook ingestion (receive POSTs from client systems) | 1-2 weeks | S3 (production deployment) |
| EDI X12 parser/generator (850, 856, 810) | 2-3 weeks | S3 |
| Credential vault (per-client API keys, encrypted) | 1 week | SA2 (formal core) |
| Multi-tenant data isolation (client_id scoping) | Part of SA2 | SA2 |
| SLA monitoring (integration uptime, sync failures) | 1-2 weeks | S3 |
| White-label web portal for clients | 2-3 weeks | S3 + S17 dashboard |

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|:---:|:---:|---|
| Anthropic Max rate limits under heavy multi-tenant use | Medium | High | Multiple accounts, auto-routing to Ollama for simple queries |
| Client API changes break integrations | Medium | Medium | Declarative HTTP tools are easy to update; auto-skills adapt |
| EDI compliance issues (format strictness) | Medium | High | Test with client's EDI validator before go-live |
| Client data leakage between tenants | Low | Critical | Row-level isolation in SA2 StorageProvider, tested with integration tests |
| Integration maintenance burden exceeds revenue | Low | Medium | Auto-skills reduce manual maintenance; declarative tools are low-maintenance |
| Client expects 24/7 uptime before infrastructure supports it | Medium | Medium | Start with SLA-free pilot, formalize SLA after proving reliability |

---

## Decision Points for Board

| Decision | When | Who Decides |
|----------|------|-------------|
| Approve production deployment (S3) | After E2E + architecture hardening | CTO + Board |
| Choose hosting platform (InMotion vs VMware vs Render) | Before S3 | CTO + IT |
| Approve first client pilot | After 1 quarter of internal production use | Board |
| Set service pricing | Before client pilot | Board + Sales |
| Hire additional development capacity | Before scaling beyond 3 clients | CTO + Board |
| Formalize SaaS as a business unit | After 3+ paying clients | Board |
