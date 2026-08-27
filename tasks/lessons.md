
## 2026-08-27 — A fallback that fakes success turns a blip into a lie

**Pattern:** Telegram photo download stalled (no timeout on `fetch`, undici's
300s bodyTimeout). The catch fell back to `handleMessage(ctx, "[Photo received] " + caption)`
— wording that tells the model an image DID arrive. Claude, given a caption and
no image, produced a confident fabricated diagnosis ("PNG is completely fine —
I read PNG, JPG, GIF, WebP"; blamed the user's Telegram client). The user then
spent a conversation debugging a format problem that never existed.

**Rules:**
1. A degraded path must never phrase itself as the success path. If the artifact
   is missing, the text handed to the model must say so explicitly.
2. Every outbound `fetch` gets an explicit deadline. "Graceful degradation"
   (Convention #6) does not mean "hang for five minutes first".
3. When an agent explains its own failure, treat the explanation as a hypothesis,
   not evidence — it is reasoning from the prompt it was handed, not from ground
   truth. Pull the artifact (`uploads/`, `chat_log`) before believing it.
4. Never classify user intent on scaffolding the system itself wrote.
   `DELIVERABLE_FORMAT_REGEX` matched our own word "file" in
   "Please read/view this image file", so every photo turn was treated as a
   document request.
