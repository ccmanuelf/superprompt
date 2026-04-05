---
name: pto_calculator
description: Calculates PTO balance from annual accrual rate, months employed, and days taken
type: generated_code
parameters:
  - name: annual_pto_days
    type: number
    description: Total PTO days granted per year
    required: true
  - name: months_employed
    type: number
    description: Number of months the employee has been employed
    required: true
  - name: days_taken
    type: number
    description: Number of PTO days already taken
    required: true
---
```javascript
const accrual = (args.annual_pto_days / 12) * args.months_employed;
const balance = accrual - args.days_taken;

return {
  accrued: Math.round(accrual * 10) / 10,
  taken: args.days_taken,
  balance: Math.round(balance * 10) / 10,
  status: balance < 0 ? 'deficit' : balance < 2 ? 'low' : 'ok'
};
```
