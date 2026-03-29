---
name: calculate_npv
description: Calculate Net Present Value, IRR, and payback period for an investment
type: generated_code
parameters:
  - name: discount_rate
    type: number
    description: Annual discount rate (e.g., 0.10 for 10%)
    required: true
  - name: initial_investment
    type: number
    description: Initial investment amount (negative number, e.g., -500000)
    required: true
  - name: cash_flows
    type: string
    description: Comma-separated annual cash flows (e.g., "150000,150000,150000,150000,150000")
    required: true
---
```javascript
const rate = Number(args.discount_rate);
const initial = Number(args.initial_investment);
const flows = String(args.cash_flows).split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));

if (flows.length === 0) return { error: "No valid cash flows provided" };
if (rate <= -1) return { error: "Discount rate must be greater than -100%" };

// NPV calculation
let npv = initial;
for (let t = 0; t < flows.length; t++) {
  npv += flows[t] / Math.pow(1 + rate, t + 1);
}

// IRR via bisection method
const calcNPV = (r) => {
  let val = initial;
  for (let t = 0; t < flows.length; t++) val += flows[t] / Math.pow(1 + r, t + 1);
  return val;
};
let low = -0.5, high = 5.0;
for (let i = 0; i < 100; i++) {
  const mid = (low + high) / 2;
  if (calcNPV(mid) > 0) low = mid; else high = mid;
}
const irr = (low + high) / 2;

// Payback period
let cumulative = initial;
let payback = null;
for (let t = 0; t < flows.length; t++) {
  cumulative += flows[t];
  if (cumulative >= 0) {
    // Fractional year: previous year's remaining balance / this year's flow
    const remaining = cumulative - flows[t];
    payback = t + (-remaining / flows[t]);
    payback = Math.round(payback * 100) / 100;
    break;
  }
}

return {
  npv: Math.round(npv * 100) / 100,
  irr_percent: Math.round(irr * 10000) / 100,
  payback_years: payback !== null ? payback : "Not recovered within projection period",
  recommendation: npv > 0 ? "INVEST — positive NPV indicates value creation" : "REJECT — negative NPV indicates value destruction",
  summary: {
    discount_rate: (rate * 100) + "%",
    initial_investment: initial,
    total_cash_inflows: flows.reduce((a, b) => a + b, 0),
    projection_years: flows.length,
    net_gain: Math.round((npv - initial + initial) * 100) / 100
  }
};
```
