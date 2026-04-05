---
name: acme_order_summary
description: "Generate a summary report of ACME Corp orders — total count, revenue, fulfillment status breakdown."
type: generated_code
parameters:
  - name: orders
    type: object
    description: "Array of orders (from acme_get_orders) to summarize"
    required: true
---
```javascript
const orders = Array.isArray(args.orders) ? args.orders : [];
const total = orders.length;
const revenue = orders.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);

const statuses = {};
for (const order of orders) {
  const status = order.fulfillment_status || 'unfulfilled';
  statuses[status] = (statuses[status] || 0) + 1;
}

const avgOrderValue = total > 0 ? revenue / total : 0;

return {
  client: 'ACME Corp',
  total_orders: total,
  total_revenue: Math.round(revenue * 100) / 100,
  avg_order_value: Math.round(avgOrderValue * 100) / 100,
  fulfillment_breakdown: statuses,
  currency: orders[0]?.currency || 'USD',
  generated_at: new Date().toISOString(),
};
```
