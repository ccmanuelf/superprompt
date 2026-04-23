---
name: hub_create_order
description: "Create a new work order in the Operations Hub. Assigns WO number, sets status to 'new', logs the source channel."
type: generated_code
parameters:
  - name: client_name
    type: string
    description: "Client/customer name"
    required: true
  - name: part_number
    type: string
    description: "Finished goods part number"
    required: true
  - name: quantity
    type: number
    description: "Order quantity"
    required: true
  - name: due_date
    type: string
    description: "Due date (YYYY-MM-DD)"
    required: true
  - name: priority
    type: string
    description: "Priority: low, normal, high, urgent (default: normal)"
    required: false
  - name: source
    type: string
    description: "Order source: telegram, email, erp, document, verbal (default: telegram)"
    required: false
---
```javascript
const now = new Date();
const woNumber = 'WO-' + now.getFullYear() + '-' + String(Math.floor(Math.random() * 9000) + 1000);
const order = {
  wo_number: woNumber,
  client: args.client_name,
  part_number: args.part_number,
  quantity: args.quantity,
  due_date: args.due_date,
  priority: args.priority || 'normal',
  status: 'new',
  progress_pcs: 0,
  progress_percent: 0,
  source: args.source || 'telegram',
  created_at: now.toISOString(),
  created_by: 'luna-bot',
};
return {
  order,
  message_en: 'Work order ' + woNumber + ' created for ' + args.client_name + ' — ' + args.quantity + ' pcs of ' + args.part_number + ', due ' + args.due_date + '. Priority: ' + order.priority + '.',
  message_es: 'Orden de trabajo ' + woNumber + ' creada para ' + args.client_name + ' — ' + args.quantity + ' pzas de ' + args.part_number + ', vence ' + args.due_date + '. Prioridad: ' + order.priority + '.',
};
```
