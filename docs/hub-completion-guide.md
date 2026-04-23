# Operations Hub (/hub) — Completion Guide for Production Planning

**For:** Production Planning, Scheduling, and Materials Management teams
**Version:** v1.0.0-rc.30 (Preview with sample data)
**Language:** English + Spanish (bilingual throughout)

---

## What's Ready NOW

The Operations Hub is pre-built and running. You can access it today:

- **Production Hub:** `http://[server]:3030/hub` — work orders, progress, alerts, activity log
- **BOM & Shortage:** `http://[server]:3030/hub/bom` — shortage alerts, alternatives, FIFO tracking

**5 conversational tools work via Telegram:**
- `hub_create_order` — create work orders
- `hub_order_status` — check WO status and progress
- `hub_update_progress` — log completed pieces
- `hub_bom_lookup` — look up bill of materials
- `hub_shortage_check` — scan for material shortages

**What's working with sample data:**
- Dashboard UI (all tabs, dark/light theme, EN/ES toggle)
- All 5 tools return realistic sample responses
- Operations coordinator skill (AI knows your workflow)
- Bilingual messages on every tool response

---

## What's Currently Mocked (Must Be Replaced)

These items use **sample/placeholder data**. They work, but show fabricated numbers. Each needs real data from your team to become production-ready.

### S17 — Order Management

| Mocked Item | Where | What to Replace With | How |
|-------------|-------|---------------------|-----|
| **WO numbering** | `hub_create_order` tool | Your actual convention (e.g., WO-YYYY-NNN) | Tell Luna: "Our WO format is WO-2026-XXXX where XXXX is sequential" |
| **Sample orders** | `hub_order_status` tool | Real order data from your system | Provide 5-10 real WOs (redacted if needed) |
| **Client names** | Sample data in tools | Your actual client list | Tell Luna: "Our clients are ACME, BetaCorp, Delta Textiles..." |
| **Part numbers** | Sample data (FG-7710-BLU) | Your actual FG part numbers | Provide 20-30 real part numbers so we can build validation |
| **Dashboard KPIs** | `/hub` dashboard | Connected to real DB queries | Requires software team (Level 3 upgrade) |

### S18 — BOM & Shortage

| Mocked Item | Where | What to Replace With | How |
|-------------|-------|---------------------|-----|
| **BOM data** | `hub_bom_lookup` tool | Your BOM API or exported BOM spreadsheet | Provide: API endpoint + auth, OR export a BOM as CSV/Excel |
| **Inventory levels** | `hub_shortage_check` tool | Your Inventory API or exported snapshot | Provide: API endpoint + auth, OR export inventory as CSV |
| **Component part numbers** | Sample data (RM-4471-BLK) | Your actual raw material part numbers | Provide a list of 30-50 RM part numbers |
| **Alternative materials** | Sample suggestions | Your approved alternatives list | Tell Luna: "RM-4471-BLK can be replaced by RM-4480-BLK" |
| **Shortage thresholds** | Hardcoded in sample data | Your safety stock / min levels | Tell Luna: "Safety stock for RM-4471 is 200 yards" |

---

## What You Need to Provide (Checklist)

### Priority 1 — Unblocks core functionality

- [ ] **Current Excel template** — The blank spreadsheet your team currently uses to normalize orders. This defines the target schema. Upload it to luna: send the file on Telegram.
- [ ] **WO numbering convention** — What format? Who assigns? Is it auto-generated or manual? Tell Luna conversationally.
- [ ] **FG part number samples** — 20-30 real finished goods part numbers. Helps build validation patterns. Send as a list or spreadsheet.

### Priority 2 — Enables real data

- [ ] **2-3 real order documents** (redacted) — Different clients, different formats. The messier the better — this teaches Luna to parse your actual order shapes. Upload via Telegram.
- [ ] **Email body example** — What does an order-by-email actually look like? Forward one to Luna (redacted).
- [ ] **Client list** — Names, contact info, preferred formats, shipping carriers. Tell Luna or send as spreadsheet.

### Priority 3 — Connects external systems

- [ ] **BOM API endpoint** — URL, authentication method (API key, OAuth, basic auth), sample response format (JSON/CSV)
- [ ] **Inventory API endpoint** — Same: URL, auth, sample response
- [ ] **API authentication credentials** — These go in `.env` file (IT team handles this)

---

## How to Load Templates

### Via Telegram (easiest)
Send any CSV, Excel, or document file to Luna on Telegram. The AI parses it automatically.

Example:
```
You: [attach order-template.xlsx]
Luna: "I've parsed your Excel file. It has columns: WO Number, Client, 
Part Number, Qty, Due Date, Priority. Want me to use this as the template 
for order ingestion?"
You: "Yes, use this as our standard order template"
```

### Via pack templates directory
Place files in `packs/operations-hub/templates/`:
```
packs/operations-hub/templates/
  order-template.xlsx        ← Your blank order form
  bom-export-sample.csv      ← Example BOM export
  inventory-snapshot.csv     ← Example inventory export
  client-profiles.csv        ← Client mappings
```

### Via conversational description
Tell Luna what you need:
```
You: "Our orders come in Excel with columns: PO Number, Style, Color, 
     Size Run, Total Qty, Ship Date. Style maps to our part number."
Luna: [updates the tool to use your column mapping]
```

---

## How to Tweak Templates and Tool Behavior

### Conversational (what YOU can do)

These changes can be made by talking to Luna — no IT team needed:

| What to Change | How to Tell Luna |
|---------------|-------------------|
| WO number format | "Our WO format is WO-YYYY-NNN, sequential" |
| Client terminology | "ACME calls part numbers 'Style Numbers'" |
| Priority levels | "We use 4 priorities: Rush, Standard, Low, Hold" |
| Shortage thresholds | "Safety stock for cotton twill is 200 yards" |
| Alternative materials | "RM-4471-BLK can be replaced with RM-4480-BLK at 95% compatibility" |
| Notification rules | "Notify the supervisor when any order is marked urgent" |
| Due date calculations | "Lead time for client ACME is 15 business days" |

### What requires the software team

| What to Change | Why IT Needed |
|---------------|--------------|
| Dashboard layout changes | HTML/CSS modification (Level 3) |
| Real-time KPI calculations | Database queries + API routes |
| Live data feeds from BOM/Inventory API | API connector configuration in `.env` |
| Custom charts or visualizations | Chart.js configuration |
| New dashboard tabs | HTML + server route additions |

---

## When You Hit a Wall

### "The tool gives wrong results"
**Tell Luna what's wrong.** Example:
```
You: "The BOM lookup for FG-7710 shows wrong components. The real BOM 
     has 8 components, not 5. Here's the correct list: [paste list]"
Luna: [updates the tool with correct data]
```

### "I need a feature the tool doesn't have"
**Describe what you need.** Luna can build Level 2 tools conversationally:
```
You: "I need a tool that calculates production ETA based on 
     current progress rate and remaining quantity"
Luna: [creates the tool, tests it, asks you to verify]
```

### "The dashboard doesn't show what I need"
**This requires the software team.** Tell Luna:
```
You: "I need the dashboard to show a Gantt chart of all active WOs"
Luna: "That dashboard modification needs the development team. 
         I can draft the requirements document for them. The tool to 
         calculate the timeline data is ready — they build the visual."
```

### "I can't connect to our BOM API"
**Contact IT.** API connections require:
1. API endpoint URL added to `.env`
2. Authentication credentials added to `.env`
3. Tool updated with real endpoint (luna or IT can do this)
4. Test with real data to verify

### How to request support from the team behind luna
Tell Luna directly:
```
You: "I need help from the development team with [description]"
Luna: [drafts a requirements document and tells you who to contact]
```

Or contact the software development team directly with:
- What you're trying to do
- What's not working
- Screenshots if relevant

---

## How to Validate: Real Data vs Sample Data

### Quick check: is this real or sample data?

The dashboards show a **preview banner** at the bottom:
- EN: "Preview — Sample data. Real connections pending."
- ES: "Vista previa — Datos de ejemplo. Conexiones reales pendientes."

When you see this banner, the data is fabricated.

### Step-by-step validation after loading real data

1. **Create a real WO via Telegram:**
   ```
   You: "Create a work order for ACME, part FG-7710-BLU, 500 pieces, due April 15"
   ```
   Verify: WO number follows YOUR convention (not WO-2026-XXXX random)

2. **Check WO status:**
   ```
   You: "What's the status of WO-2026-0001?"
   ```
   Verify: Shows YOUR real order data, not sample data

3. **Look up BOM:**
   ```
   You: "Look up BOM for FG-7710-BLU"
   ```
   Verify: Components match YOUR bill of materials, not sample components

4. **Check shortages:**
   ```
   You: "Any material shortages?"
   ```
   Verify: Shows YOUR real inventory levels, not hardcoded numbers

5. **Open `/hub` in browser:**
   Verify: Dashboard shows YOUR work orders, not sample ones
   Verify: KPIs reflect YOUR actual production numbers
   Verify: Preview banner is GONE (means real data is connected)

### Signs you're on real data:
- ✅ WO numbers follow your convention
- ✅ Client names match your actual clients
- ✅ Part numbers match your actual catalog
- ✅ BOM components match your engineering data
- ✅ Inventory levels match your warehouse counts
- ✅ Preview banner is removed from dashboards

### Signs you're still on sample data:
- ⚠️ WO numbers like "WO-2026-XXXX" (random)
- ⚠️ Clients named "ACME Garments", "BetaCorp", "Delta Textiles"
- ⚠️ Part numbers like "FG-7710-BLU", "RM-4471-BLK" (fabricated)
- ⚠️ Preview banner visible at bottom of dashboard

---

## Current Assumptions in Sample Data

These assumptions were made to build the preview. **Correct them** by telling Luna the real values:

| Assumption | Sample Value | Tell Luna your real value |
|-----------|-------------|---------------------------|
| WO format | WO-YYYY-NNNN (random) | "Our WOs are formatted as [your format]" |
| Default quantity | 500 pcs | "Our typical order is [your range] pcs" |
| Production lines | Line 1, Line 2, Line 3 | "We have [your lines] named [names]" |
| Shifts | 2 shifts | "We run [number] shifts: [hours]" |
| BOM structure | 5 components per FG | "Typical BOM has [number] components" |
| Safety stock | Not defined | "Safety stock for [material] is [quantity]" |
| Lead times | Not defined | "Lead time for [client] is [days] business days" |
| Approval chain | Not defined | "BOM overrides need approval from [role]" |

---

## Summary: What to Do Next

1. **TODAY:** Open `/hub` and `/hub/bom` — explore the interface, get familiar
2. **THIS WEEK:** Provide Priority 1 items (Excel template, WO format, part numbers)
3. **NEXT WEEK:** Provide Priority 2 items (sample orders, email examples, client list)
4. **WHEN READY:** Provide Priority 3 items (API endpoints and credentials)
5. **ONGOING:** Fine-tune via conversation — Luna adapts to your corrections

The more data you provide, the more accurate the hub becomes. Start with what you have — Luna learns incrementally.

---

*Operations Hub Completion Guide — Luna v1.0.0-rc.30*
*Questions? Tell Luna: "I need help with the operations hub setup"*
