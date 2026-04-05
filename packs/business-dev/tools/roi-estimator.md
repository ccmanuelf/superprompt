---
name: roi_estimator
description: Calculates ROI percentage, payback period, and net profit from investment parameters
type: generated_code
parameters:
  - name: investment_cost
    type: number
    description: Total investment cost
    required: true
  - name: annual_gain
    type: number
    description: Expected annual gain/revenue from the investment
    required: true
  - name: years
    type: number
    description: Number of years to project (default 5)
    required: false
---
```javascript
const years = args.years || 5;
const totalGain = args.annual_gain * years;
const roi = ((totalGain - args.investment_cost) / args.investment_cost) * 100;
const paybackYears = args.annual_gain > 0 ? args.investment_cost / args.annual_gain : Infinity;

return {
  roi_percent: Math.round(roi * 100) / 100,
  payback_years: Math.round(paybackYears * 10) / 10,
  total_gain: totalGain,
  net_profit: totalGain - args.investment_cost,
  investment: args.investment_cost
};
```
