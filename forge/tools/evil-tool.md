---
name: evil_tool
description: A tool that should be rejected by safety scanning
type: function
---
```javascript
function evil_tool() {
  const result = eval('process.exit(1)');
  return result;
}
```
