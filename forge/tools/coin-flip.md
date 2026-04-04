---
name: coin_flip
description: Flip a coin and return heads or tails. Useful when the user needs a random decision.
type: generated_code
parameters: []
---
```typescript
const side = Math.random() < 0.5 ? 'Heads' : 'Tails';
return { result: side };
```
