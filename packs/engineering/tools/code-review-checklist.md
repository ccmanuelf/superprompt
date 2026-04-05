---
name: code_review_checklist
description: Generates a structured code review checklist from a description of the change
type: generated_code
parameters:
  - name: change_description
    type: string
    description: Description of the code change being reviewed
    required: true
  - name: language
    type: string
    description: Programming language or framework (default "general")
    required: false
---
```javascript
const checks = [
  'Logic correctness',
  'Edge case handling',
  'Error handling',
  'Performance impact',
  'Security implications',
  'Test coverage',
  'Documentation updated',
  'Naming conventions',
  'Code duplication',
  'Dependency changes'
];

const items = checks.map((c, i) => ({
  id: i + 1,
  check: c,
  status: 'pending'
}));

return {
  change: args.change_description,
  language: args.language || 'general',
  checklist: items,
  total: items.length,
  completed: 0
};
```
