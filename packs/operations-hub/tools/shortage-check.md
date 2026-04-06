---
name: hub_shortage_check
description: "Check for material shortages across all active work orders. Returns critical shortages with alternative suggestions."
type: generated_code
parameters:
  - name: severity
    type: string
    description: "Filter by severity: all, critical, warning (default: all)"
    required: false
---
```javascript
// Sample shortage data — will be replaced with real inventory API
const shortages = [
  { part: 'RM-4471-BLK', desc: 'Black Cotton Twill 60"', on_hand: 0, required: 300, affected_wos: ['WO-2026-2847'], severity: 'critical', alternatives: ['RM-4471-CHR (Charcoal Twill)', 'RM-4480-BLK (Black Poly-Cotton)'] },
  { part: 'LB-0050-BLU', desc: 'Care Label - Blue', on_hand: 100, required: 500, affected_wos: ['WO-2026-2847'], severity: 'warning', alternatives: ['LB-0050-GEN (Generic Care Label)'] },
  { part: 'RM-6601-RED', desc: 'Red Polyester Lining', on_hand: 50, required: 200, affected_wos: ['WO-2026-2852'], severity: 'warning', alternatives: [] },
];
const filter = args.severity || 'all';
const filtered = filter === 'all' ? shortages : shortages.filter(s => s.severity === filter);
return {
  total_shortages: filtered.length,
  critical: filtered.filter(s => s.severity === 'critical').length,
  warnings: filtered.filter(s => s.severity === 'warning').length,
  items: filtered.map(s => ({
    part: s.part,
    description: s.desc,
    on_hand: s.on_hand,
    required: s.required,
    gap: s.required - s.on_hand,
    severity: s.severity,
    affected_work_orders: s.affected_wos,
    alternatives: s.alternatives,
  })),
  message_en: filtered.length + ' shortage(s) detected. ' + filtered.filter(s => s.severity === 'critical').length + ' critical, ' + filtered.filter(s => s.severity === 'warning').length + ' warning(s).',
  message_es: filtered.length + ' faltante(s) detectado(s). ' + filtered.filter(s => s.severity === 'critical').length + ' critico(s), ' + filtered.filter(s => s.severity === 'warning').length + ' advertencia(s).',
};
```
