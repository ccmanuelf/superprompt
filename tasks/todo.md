# Photo/PNG ingestion failure — 2026-08-27

## Diagnosis (evidence, prod .244)
- 2x `Photo handler failed` (19:02:01, 19:08:08): `fetch failed: HTTP/2: "stream timeout after 300000"`
  = undici default bodyTimeout on an untimed `fetch`. Image never written to uploads/.
- `chat_log` shows 2x `[Photo received] <caption>` fallbacks -> model told a photo arrived
  when none did -> Claude confabulated a PNG/Telegram diagnosis.
- Egress healthy (1MB/5MB in 327/749ms; H1 & H2 both 8/8). Ollama path excluded
  (OLLAMA_TIMEOUT_MS unset -> 600000, not 300000).
- Failure occurs in transport, BEFORE any format logic. Photos are JPEG by then.

## Tasks
- [x] A. Timeout + retry + step-level logging on Telegram getFile/download (photo + document)
- [x] B. Honest failure text: never claim a photo was received when it was not (telegram + matrix)
- [x] C. Image formats: files.ts recognises images; document handler routes images to the
       vision path instead of the text parser (PNG-as-file currently unreadable)
- [x] D. Deliverable misfire: thread the user's caption as rawUserMessage so
       DELIVERABLE_FORMAT_REGEX stops matching "file" in Luna's own wrapper text

## Review
All four shipped in rc.148.
- A: `withDeadline()` (45s) around getFile; `downloadTelegramFile()` = 45s/attempt,
  3 attempts, 4xx short-circuits, logs bytes/ms/attempt/fileSize/mime.
- B: failure paths now reply with an explicit "it never reached me" notice and do
  NOT invoke the model. Matrix gets an explicit "FAILED to download" framing.
- C: images route to `deliverImageToProvider()` (shared by photo + document
  handlers); `files.ts` gains an `image` format whose error says "view it, do not
  parse it" instead of "Unsupported file format".
- D: `rawUserMessageOverride` threads the user's caption to the router, so
  deliverable-intent classification reads the user's words, not our scaffolding.

Verification: tsc clean, eslint clean, vitest 3119 passed / 0 failed / 1 skipped
(+6 new), build ok, 9/9 dist smoke. The 4 substantive new tests were confirmed to
FAIL against pre-fix `src/` (git stash) and pass after.

Not proven: why Telegram stalled. It is upstream and intermittent (egress, H1/H2
and 1MB/5MB downloads all healthy when measured). The new logging records
fileSize/mime/attempt/ms so the next occurrence is diagnosable rather than silent.
