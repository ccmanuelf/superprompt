---
name: cycle_count_planner
description: Plans cycle count schedule based on ABC classification with frequency and daily workload estimation
type: generated_code
parameters:
  - name: total_skus
    type: number
    description: Total number of SKUs in the warehouse
    required: true
  - name: a_percent
    type: number
    description: Percentage of SKUs classified as A-items (default 20)
    required: false
  - name: b_percent
    type: number
    description: Percentage of SKUs classified as B-items (default 30)
    required: false
  - name: c_percent
    type: number
    description: Percentage of SKUs classified as C-items (default 50)
    required: false
---
```javascript
const total = args.total_skus;
const aSkus = Math.round(total * (args.a_percent || 20) / 100);
const bSkus = Math.round(total * (args.b_percent || 30) / 100);
const cSkus = total - aSkus - bSkus;

return {
  classification: {
    A: { skus: aSkus, count_frequency: 'monthly', annual_counts: aSkus * 12 },
    B: { skus: bSkus, count_frequency: 'quarterly', annual_counts: bSkus * 4 },
    C: { skus: cSkus, count_frequency: 'annually', annual_counts: cSkus }
  },
  total_skus: total,
  total_annual_counts: aSkus * 12 + bSkus * 4 + cSkus,
  daily_counts: Math.ceil((aSkus * 12 + bSkus * 4 + cSkus) / 250)
};
```
