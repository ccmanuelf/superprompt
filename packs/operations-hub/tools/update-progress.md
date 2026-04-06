---
name: hub_update_progress
description: "Update production progress for a work order — logs completed pieces and recalculates ETA."
type: generated_code
parameters:
  - name: wo_number
    type: string
    description: "Work order number"
    required: true
  - name: completed_pcs
    type: number
    description: "Total pieces completed so far"
    required: true
  - name: notes
    type: string
    description: "Optional progress notes"
    required: false
---
```javascript
const pct = args.completed_pcs > 0 ? Math.round(args.completed_pcs / 500 * 100) : 0;
const status = pct >= 100 ? 'complete' : pct > 0 ? 'in_production' : 'new';
return {
  wo_number: args.wo_number,
  completed_pcs: args.completed_pcs,
  progress_percent: Math.min(pct, 100),
  status: status,
  notes: args.notes || '',
  updated_at: new Date().toISOString(),
  message_en: 'Progress updated: ' + args.wo_number + ' — ' + args.completed_pcs + ' pcs completed (' + Math.min(pct, 100) + '%). Status: ' + status + '.',
  message_es: 'Progreso actualizado: ' + args.wo_number + ' — ' + args.completed_pcs + ' pzas completadas (' + Math.min(pct, 100) + '%). Estado: ' + status + '.',
};
```
