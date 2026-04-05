---
name: duty_estimator
description: Estimates import duty, merchandise processing fee, and total landed cost from declared value and duty rate
type: generated_code
parameters:
  - name: declared_value
    type: number
    description: Declared/transaction value of the imported goods
    required: true
  - name: duty_rate_percent
    type: number
    description: Duty rate percentage from HTS classification (e.g., 5.5 for 5.5%)
    required: true
  - name: processing_fee
    type: number
    description: Flat processing/entry fee (default 25)
    required: false
  - name: merchandise_processing_fee_percent
    type: number
    description: MPF percentage (default 0.3464 for US CBP)
    required: false
---
```javascript
const duty = args.declared_value * (args.duty_rate_percent / 100);
const mpf = args.declared_value * ((args.merchandise_processing_fee_percent || 0.3464) / 100);
const fee = args.processing_fee || 25;
const total = duty + mpf + fee;

return {
  declared_value: args.declared_value,
  duty_amount: Math.round(duty * 100) / 100,
  duty_rate: args.duty_rate_percent + '%',
  mpf: Math.round(mpf * 100) / 100,
  processing_fee: fee,
  total_duties: Math.round(total * 100) / 100,
  landed_cost: Math.round((args.declared_value + total) * 100) / 100
};
```
