---
name: sla_tracker
description: Checks SLA compliance by comparing ticket response times against priority-based targets
type: generated_code
parameters:
  - name: tickets
    type: object
    description: "Array of ticket objects with {priority: 'critical'|'high'|'medium'|'low', response_hours: number}"
    required: true
---
```javascript
const targets = { critical: 1, high: 4, medium: 8, low: 24 };

const results = (args.tickets || []).map(t => {
  const target = targets[t.priority] || 24;
  return {
    priority: t.priority,
    response_hours: t.response_hours,
    target_hours: target,
    met_sla: t.response_hours <= target
  };
});

const met = results.filter(r => r.met_sla).length;

return {
  total: results.length,
  met_sla: met,
  missed_sla: results.length - met,
  compliance_percent: results.length > 0 ? Math.round(met / results.length * 100) : 100,
  details: results
};
```
