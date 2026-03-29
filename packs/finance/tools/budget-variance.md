---
name: budget_variance
description: Analyze budget variance — compare actual vs budgeted spend and flag overruns
type: generated_code
parameters:
  - name: data
    type: string
    description: "JSON array of budget lines, each with: department, category, budgeted (number), actual (number), period"
    required: true
  - name: threshold
    type: number
    description: Variance threshold percentage to flag as overrun (default 10)
    required: false
---
```javascript
let lines;
try {
  lines = JSON.parse(args.data);
} catch (e) {
  return { error: "Invalid JSON data. Expected array of {department, category, budgeted, actual, period}" };
}

if (!Array.isArray(lines) || lines.length === 0) {
  return { error: "Data must be a non-empty array of budget lines" };
}

const threshold = args.threshold ? Number(args.threshold) : 10;

const analyzed = lines.map(line => {
  const budgeted = Number(line.budgeted) || 0;
  const actual = Number(line.actual) || 0;
  const variance = actual - budgeted;
  const variancePct = budgeted !== 0 ? Math.round((variance / budgeted) * 10000) / 100 : 0;

  return {
    department: line.department || "Unknown",
    category: line.category || "Unknown",
    period: line.period || "Unknown",
    budgeted,
    actual,
    variance: Math.round(variance * 100) / 100,
    variance_percent: variancePct,
    status: variancePct > threshold ? "OVER" : variancePct < -threshold ? "UNDER" : "OK"
  };
});

const totalBudgeted = analyzed.reduce((s, l) => s + l.budgeted, 0);
const totalActual = analyzed.reduce((s, l) => s + l.actual, 0);
const totalVariance = totalActual - totalBudgeted;

const overruns = analyzed.filter(l => l.status === "OVER");
const underruns = analyzed.filter(l => l.status === "UNDER");

// Department rollup
const deptMap = {};
for (const line of analyzed) {
  if (!deptMap[line.department]) deptMap[line.department] = { budgeted: 0, actual: 0 };
  deptMap[line.department].budgeted += line.budgeted;
  deptMap[line.department].actual += line.actual;
}
const byDepartment = Object.entries(deptMap).map(([dept, vals]) => ({
  department: dept,
  budgeted: vals.budgeted,
  actual: vals.actual,
  variance: Math.round((vals.actual - vals.budgeted) * 100) / 100,
  variance_percent: vals.budgeted !== 0 ? Math.round(((vals.actual - vals.budgeted) / vals.budgeted) * 10000) / 100 : 0
}));

return {
  summary: {
    total_budgeted: Math.round(totalBudgeted * 100) / 100,
    total_actual: Math.round(totalActual * 100) / 100,
    total_variance: Math.round(totalVariance * 100) / 100,
    total_variance_percent: totalBudgeted !== 0 ? Math.round((totalVariance / totalBudgeted) * 10000) / 100 : 0,
    lines_analyzed: analyzed.length,
    overruns: overruns.length,
    underruns: underruns.length,
    threshold_used: threshold + "%"
  },
  overrun_alerts: overruns.map(l => `${l.department}/${l.category}: ${l.variance_percent}% over budget (+${l.variance})`),
  by_department: byDepartment,
  detail: analyzed
};
```
