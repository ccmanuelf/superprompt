# End-to-End Test Checklist

Manual test sequence for validating all new features (Phases A–E).

## Prerequisites

- [x] `npm run build` succeeds with zero errors
- [x] `npm test` — all tests pass
- [x] Ollama running with `nomic-embed-text` pulled: `ollama pull nomic-embed-text`
- [x] Bot running: `npm run dev` or `docker compose up -d --build`

---

## Telegram Tests

### Skills (Phase E)
1. [x] `/skill list` → shows 5 built-in skills (general, translator, analyst, coder, summarizer)
2. [x] `/skill show translator` → displays description, tools, system prompt
3. [x] `/skill use translator` → "Traduce esto al inglés: Hola mundo" → translates correctly
4. [x] `/skill use analyst` → ask data question → analyst persona responds
5. [x] `/skill off` → returns to default behavior
6. [x] `/skill create pirate "Pirate assistant" "You are a pirate. Respond in pirate speak."` → created
7. [x] `/skill use pirate` → send message → pirate-style response
8. [x] `/skill delete pirate` → deleted successfully
9. [x] `/skill current` → shows active skill or "no skill"

### File Reading (Phase B)
10. [x] Send a CSV file → bot parses and summarizes content
11. [x] Send a PDF file → bot extracts text and discusses content
12. [x] Send a DOCX file → bot reads and responds about content
13. [x] Send a JSON file → bot formats and discusses
14. [x] Send a file > 50MB → bot responds with size limit error
15. [x] Send a corrupted/unknown format → bot handles gracefully

### Document Generation (Phase C)
16. [x] "Create an Excel spreadsheet with 3 columns: Name, Age, City and 5 rows of sample data" → receives XLSX file
17. [x] "Generate a PDF report about productivity tips" → receives PDF file (+ charts tested)
18. [x] "Create a CSV of the 10 most spoken languages and their speakers" → receives CSV file
19. [x] "Make a DOCX document with a summary of our conversation" → receives DOCX file (+ charts tested)

### Hybrid Memory (Phase A)
20. [x] Send: "I really love hiking in the mountains and my favorite trail is Torres del Paine"
21. [x] Wait a moment, then ask: "What outdoor activities do I enjoy?" (using different words) → hybrid search finds the memory semantically
22. [x] `/memory` → verify memory is stored with embedding
23. [x] Stop Ollama → send a message → memory search falls back to FTS5-only without errors
24. [x] Restart Ollama → verify embeddings work again

### Scheduler (existing + Phase D parity)
25. [x] `/schedule create "What's the weather?" "*/5 * * * *"` → task created
26. [x] Wait 5 min → notification received with AI response
27. [x] `/schedule list` → shows the task
28. [x] `/schedule delete <id>` → cleaned up

---

## Matrix Tests

### Skills (Phase E)
29. [ ] `!skill list` → shows same 5 skills
30. [ ] `!skill use translator` → send text → translates
31. [ ] `!skill off` → back to default

### File Handling (Phase B + D)
32. [ ] Send a DOCX file → bot parses and responds
33. [ ] Send a CSV file → bot parses and responds

### Photo Handling (Phase D)
34. [ ] Send a photo → bot downloads, saves, and describes the image

### Scheduler (Phase D)
35. [ ] `!schedule create "test" "*/5 * * * *"` → task created
36. [ ] Wait → notification appears in Matrix room
37. [ ] `!schedule list` → shows the task
38. [ ] `!schedule delete <id>` → cleaned up

### Document Generation (Phase C + D)
39. [ ] Ask for a spreadsheet in Matrix → file sent back

---

## Cross-Feature Tests

40. [x] Upload CSV → ask bot to create a report from it (B → C pipeline)
41. [x] Activate analyst skill → send file → verify skill prompt + tool filtering works (E + B)
42. [x] Memory from file discussion is found semantically later (A + B)
43. [x] Scheduled task fires → notification appears on correct platform (D)

---

## Docker Deployment

44. [x] `docker compose up -d --build` — all containers healthy
45. [x] sqlite-vec extension loads (check logs for "Migration: added embedding column")
46. [x] nomic-embed-text model pull succeeds (check entrypoint logs)
47. [x] All npm packages install without errors in Docker build
48. [x] Container health check passes
49. [x] File uploads dir is writable
50. [x] Generated documents are sendable from container
