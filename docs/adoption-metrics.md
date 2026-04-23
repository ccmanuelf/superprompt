# luna — Adoption & ROI Metrics Guide

**For:** CTO, Department Champions, Board of Directors

---

## What to Track

### Usage Metrics (available from logs and DB)

| Metric | How to Measure | What It Tells You |
|--------|---------------|-------------------|
| **Messages per day** (by department) | `docker logs` grep for chatId prefixes | Which departments are actually using luna |
| **Tool calls per day** (by tool name) | Pack tuner `pack_weights` table | Which tools deliver value, which are unused |
| **Provider split** (Claude vs Ollama) | Rate limiter records | Cost distribution across providers |
| **Pack usage** (by pack name) | Pack tuner weights | Which department packs are succeeding |
| **Skill activations** (auto-triggered) | Skill activation logs | How often specialized personas engage |
| **Auto-skills created** | `skill_proposals` table (status=approved) | How much luna is learning from users |
| **Voice vs text** | Voice transcription logs | Production floor adoption (voice = floor workers) |
| **Dashboard visits** | Web server access logs | Which visual tools get used |
| **Learning sessions** | `learning_sessions` table | Training engagement |
| **Documents generated** | Tool execution logs for generate_document | Automation of report creation |

### Quality Metrics

| Metric | How to Measure | Healthy Target |
|--------|---------------|---------------|
| **Quality score average** | Self-monitor quality_log table | >70/100 |
| **Guardrails created** | `guardrails` table count | Growing = learning |
| **Context health** | Yellow/red suggestion frequency | Rare = good conversations |
| **Circuit breaker trips** | Circuit breaker logs | Rare = tools working well |
| **Rate limit hits** | Rate limiter logs | Rare = capacity sufficient |
| **Trust decisions** | `tool_trust` table | More "allow" = user confidence growing |

---

## How to Interpret as ROI Signals

### Early Adoption (Week 1-2)

| Signal | Meaning | Action |
|--------|---------|--------|
| 50+ messages/day from one department | Department engaged | Expand to second department |
| <10 messages/day company-wide | Low adoption | Check onboarding, assign champions |
| Voice messages >30% | Production floor using it | Voice is working — good sign |
| 5+ auto-skills created | luna learning from real workflows | Platform is adapting — showcase |

### Growth (Month 1-2)

| Signal | Meaning | Action |
|--------|---------|--------|
| 200+ messages/day | Company-wide adoption | Monitor rate limits, consider second instance |
| Multiple packs active per chat | Cross-department value | Document for Board |
| Documents generated daily | Report automation working | Quantify capacity unlocked for higher-value work |
| Learning sessions active | Training engagement | Track completion rates |

### Maturity (Month 3+)

| Signal | Meaning | Action |
|--------|---------|--------|
| Pack weights diverging | System adapting to real use patterns | Review which packs need improvement |
| Guardrails accumulating | System learning from mistakes | Audit guardrails quarterly |
| Client pack active | Revenue opportunity validated | Formalize SaaS offering |
| <5% circuit breaker trips | Tools reliable | Ready for client-facing use |

---

## Quick Dashboard Queries

### Messages by department (last 24h)
```bash
docker logs luna-bot --since 24h 2>&1 | grep "Routing message" | wc -l
```

### Most used tools (from pack tuner)
```bash
docker exec luna-bot node -e "
const db = require('better-sqlite3')('/app/store/luna.db');
const rows = db.prepare('SELECT pack_name, SUM(total_calls) as calls, ROUND(AVG(weight),2) as avg_weight FROM pack_weights GROUP BY pack_name ORDER BY calls DESC').all();
rows.forEach(r => console.log(r.pack_name + ': ' + r.calls + ' calls, weight: ' + r.avg_weight));
db.close();
"
```

### Auto-skills created
```bash
docker exec luna-bot node -e "
const db = require('better-sqlite3')('/app/store/luna.db');
const count = db.prepare(\"SELECT COUNT(*) as n FROM skill_proposals WHERE status='approved'\").get();
console.log('Auto-skills approved:', count.n);
db.close();
"
```

### Guardrails accumulated
```bash
docker exec luna-bot node -e "
const db = require('better-sqlite3')('/app/store/luna.db');
const rows = db.prepare('SELECT source, COUNT(*) as n FROM guardrails GROUP BY source').all();
rows.forEach(r => console.log(r.source + ': ' + r.n));
db.close();
"
```

---

## Reporting to the Board

### Monthly Report Template

```
luna Adoption Report — [Month Year]

USAGE
- Total messages: ___
- Active departments: ___/9
- Provider split: Claude ___% / Ollama ___%
- Voice messages: ___%

AUTOMATION
- Documents generated: ___
- Tools executed: ___
- Auto-skills created: ___

QUALITY
- Average quality score: ___/100
- Circuit breaker trips: ___
- Guardrails learned: ___

VALUE
- Capacity unlocked (hours redirected to higher-value work): ___
- New clients/orders handled without additional headcount: ___
- Reports automated: ___
- Key wins: [specific examples from departments]

NEXT STEPS
- [What's planned for next month]
```

---

*luna v1.0.0-rc.31 — Adoption & ROI Metrics Guide*
