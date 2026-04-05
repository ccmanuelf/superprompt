---
name: lead_time_estimator
description: Calculates total lead time from supplier lead time, transit days, inspection days, and buffer days
type: generated_code
parameters:
  - name: supplier_lead_days
    type: number
    description: Number of days for the supplier to manufacture/prepare the order
    required: true
  - name: transit_days
    type: number
    description: Number of days for shipping/transit from supplier to destination
    required: true
  - name: inspection_days
    type: number
    description: Number of days for incoming quality inspection
    required: true
  - name: buffer_days
    type: number
    description: Safety buffer days for delays (default 2)
    required: false
---
```javascript
const buffer = args.buffer_days != null ? args.buffer_days : 2;
const total = args.supplier_lead_days + args.transit_days + args.inspection_days + buffer;

return {
  total_lead_time: total,
  breakdown: {
    supplier: args.supplier_lead_days,
    transit: args.transit_days,
    inspection: args.inspection_days,
    buffer: buffer
  }
};
```
