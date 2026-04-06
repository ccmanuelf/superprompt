---
name: hub_order_status
description: "Check work order status — returns progress, priority, ETA, and assigned personnel."
type: generated_code
parameters:
  - name: wo_number
    type: string
    description: "Work order number (e.g., WO-2026-1234)"
    required: true
---
```javascript
// Sample data — will be replaced with real DB queries when schema is finalized
const sampleOrders = {
  'WO-2026-2847': { client: 'ACME Garments', part: 'FG-7710-BLU', qty: 500, progress: 360, status: 'in_production', priority: 'high', due: '2026-04-05', assignee: 'Line 3' },
  'WO-2026-2851': { client: 'BetaCorp', part: 'FG-3301-WHT', qty: 1200, progress: 0, status: 'pending_materials', priority: 'normal', due: '2026-04-10', assignee: 'Unassigned' },
  'WO-2026-2839': { client: 'Delta Textiles', part: 'FG-5520-RED', qty: 800, progress: 800, status: 'complete', priority: 'normal', due: '2026-04-01', assignee: 'Line 1' },
};
const order = sampleOrders[args.wo_number];
if (!order) {
  return {
    error_en: 'Work order ' + args.wo_number + ' not found. Check the WO number and try again.',
    error_es: 'Orden de trabajo ' + args.wo_number + ' no encontrada. Verifica el numero de OT e intenta de nuevo.',
  };
}
const pct = Math.round(order.progress / order.qty * 100);
return {
  wo_number: args.wo_number,
  client: order.client,
  part_number: order.part,
  quantity: order.qty,
  completed: order.progress,
  progress_percent: pct,
  status: order.status,
  priority: order.priority,
  due_date: order.due,
  assigned_to: order.assignee,
  message_en: args.wo_number + ': ' + order.client + ' — ' + order.progress + '/' + order.qty + ' pcs (' + pct + '%). Status: ' + order.status + '. Due: ' + order.due + '.',
  message_es: args.wo_number + ': ' + order.client + ' — ' + order.progress + '/' + order.qty + ' pzas (' + pct + '%). Estado: ' + order.status + '. Vence: ' + order.due + '.',
};
```
