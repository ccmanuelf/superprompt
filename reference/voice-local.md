# Local Voice — Speaches + Kokoro-82M TTS + Faster-whisper STT

## Architecture

```
┌─────────────────────────────────────────┐
│  Speaches Docker Container (port 8000)  │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │  OpenAI-compatible REST API     │    │
│  │  /v1/audio/transcriptions (STT) │    │
│  │  /v1/audio/speech (TTS)         │    │
│  └──────────┬──────────────────────┘    │
│             │                           │
│  ┌──────────┴──────────┐                │
│  │  Faster-whisper      │  (STT engine) │
│  │  Kokoro-82M          │  (TTS engine) │
│  └─────────────────────┘                │
└─────────────────────────────────────────┘
```

- Single Docker container provides both STT and TTS
- API is OpenAI-compatible — use the `openai` npm package
- Models loaded via POST to `/v1/models/{model_id}` on first use, then cached in a Docker named volume
- The entrypoint script (`docker/entrypoint.sh`) auto-loads both models on container startup

---

## Docker Compose Configuration

Speaches is defined as a service in the main `docker-compose.yml`:

```yaml
services:
  speaches:
    image: ghcr.io/speaches-ai/speaches:latest-cpu
    container_name: luna-speaches
    volumes:
      - speaches-models:/root/.cache
    environment:
      # Models are loaded via POST API, not env vars
      - UVICORN_HOST=0.0.0.0
    healthcheck:
      # curl is NOT available in the Speaches image — use python3
      test: ["CMD", "python3", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 120s  # Models need time to load on first start
    networks:
      - luna-net
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 2G

volumes:
  speaches-models:
```

### Model Loading

Models are NOT configured via environment variables. They are loaded via the REST API:

```bash
# Load STT model (fully-qualified HuggingFace ID)
curl -X POST http://localhost:8000/v1/models/Systran/faster-whisper-small

# Load TTS model (fully-qualified HuggingFace ID)
curl -X POST http://localhost:8000/v1/models/speaches-ai/Kokoro-82M-v1.0-ONNX
```

The `docker/entrypoint.sh` script does this automatically on container startup (in the background, non-blocking).

---

## Model Choices

### STT: Systran/faster-whisper-small
- **Model ID**: `Systran/faster-whisper-small` (fully-qualified HuggingFace ID — NOT just `whisper-small`)
- **Language**: Auto-detects (supports 99 languages). Do NOT set `language` param.
- **Size**: ~850MB RAM when loaded
- **Speed**: ~3-6 seconds for 30 seconds of audio (on Apple Silicon)
- **Quality**: Excellent accuracy across EN, ES, and many other languages

### TTS: Kokoro-82M (replaces Piper)
- **Model ID**: `speaches-ai/Kokoro-82M-v1.0-ONNX` (ONNX-optimized for CPU)
- **Quality**: Ranked #1 in TTS Arena. Much more natural than Piper.
- **Speed**: ~200-300ms synthesis for a paragraph
- **Voices**: Auto-selected based on detected text language:
  - `af_heart` — American English female (Grade A)
  - `ef_dora` — Spanish female
- **Language detection**: Uses `franc-min` library (ISO 639-3 codes)
- **All available voices**: 53 voices across EN, ES, FR, IT, PT, JA, ZH, HI (see Speaches API)

---

## Implementation (`src/voice.ts`)

### STT — Transcribe Audio

```typescript
import OpenAI from 'openai';
import { createReadStream, renameSync } from 'node:fs';

const speachesClient = new OpenAI({
  baseURL: config.SPEACHES_URL,
  apiKey: 'not-needed', // Speaches doesn't require auth
});

export async function transcribeAudio(audioPath: string): Promise<string> {
  // GOTCHA: Telegram sends .oga, whisper needs .ogg
  // They're the same format, just different extension
  let finalPath = audioPath;
  if (audioPath.endsWith('.oga')) {
    finalPath = audioPath.replace(/\.oga$/, '.ogg');
    renameSync(audioPath, finalPath);
  }

  // Omit language param — Faster-whisper auto-detects (supports 99 languages)
  const transcription = await speachesClient.audio.transcriptions.create({
    file: createReadStream(finalPath),
    model: 'Systran/faster-whisper-small',
  });

  return transcription.text;
}
```

### TTS — Synthesize Speech (with language detection)

```typescript
import { franc } from 'franc-min';

const VOICE_MAP: Record<string, { voice: string; lang: string }> = {
  spa: { voice: 'ef_dora', lang: 'es' },
  eng: { voice: 'af_heart', lang: 'en' },
};
const DEFAULT_VOICE = VOICE_MAP.eng;

export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const detected = franc(text);
  const { voice } = VOICE_MAP[detected] ?? DEFAULT_VOICE;

  const response = await speachesClient.audio.speech.create({
    model: 'speaches-ai/Kokoro-82M-v1.0-ONNX',
    voice,
    input: text,
    response_format: 'mp3',
  });

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
```

### Health Check

```typescript
export async function voiceCapabilities(): Promise<{
  stt: boolean;
  tts: boolean;
}> {
  const baseUrl = config.SPEACHES_URL.replace(/\/v1\/?$/, '');
  try {
    const response = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (response.ok) {
      return { stt: true, tts: true };
    }
  } catch {
    // Speaches not reachable — graceful degradation
  }
  return { stt: false, tts: false };
}
```

---

## Integration with Messaging Platforms

### Telegram Voice Notes
1. User sends voice note → Telegram delivers `.oga` file
2. Bot downloads via `bot.api.getFile(file_id)` → saves to `workspace/uploads/`
3. Call `transcribeAudio(filePath)` → get text (language auto-detected)
4. Prepend `[Voice transcribed]: ` to message, process normally
5. If `forceVoiceReply` is set, call `synthesizeSpeech(response)` → send as voice note
6. TTS voice auto-matches the language of the AI response

### Matrix Voice Messages
1. User sends `m.audio` event with `mxc://` URL
2. Bot downloads via `client.downloadContent(mxcUrl)` → saves to `workspace/uploads/`
3. Same flow as Telegram from step 3

### Voice Reply Logic
- If user sends voice → respond with voice + text
- If user sends text → respond with text only
- `/voice` command toggles always-voice mode for that chat

---

## Known Gotchas

1. **Model IDs are fully-qualified HuggingFace IDs**: Use `Systran/faster-whisper-small` not `whisper-small`, and `speaches-ai/Kokoro-82M-v1.0-ONNX` not `kokoro`. The short names return 404.

2. **Models loaded via API, not env vars**: Speaches does NOT use `WHISPER_MODEL` or `PIPER_VOICE` env vars. Models must be loaded via POST to `/v1/models/{model_id}`.

3. **No curl in Speaches image**: Docker healthcheck must use `python3 -c "import urllib.request; ..."` instead of `curl`.

4. **OGA → OGG rename**: Telegram voice notes use `.oga` extension. Faster-whisper requires `.ogg`. They are the same Opus codec in Ogg container — just rename.

5. **Language auto-detection**: STT auto-detects language (omit `language` param). TTS uses `franc-min` to detect response text language and select the matching Kokoro voice.

6. **Cold start latency**: First request after container start takes 10-30s while models load. The entrypoint preloads models in the background. `start_period: 120s` in healthcheck handles this.

7. **Memory usage**: Faster-whisper-small ~850MB + Kokoro-82M ~200MB. Total: ~1-1.5GB for the Speaches container.

8. **Concurrent requests**: Speaches handles one request at a time per model. For a single-user bot, this is fine. STT and TTS can run concurrently since they're different models.

---

## Testing

### Manual Test
```bash
# Check Speaches is running
curl http://localhost:8000/health

# Load models (if not already loaded by entrypoint)
curl -X POST http://localhost:8000/v1/models/Systran/faster-whisper-small
curl -X POST http://localhost:8000/v1/models/speaches-ai/Kokoro-82M-v1.0-ONNX

# List loaded models
curl http://localhost:8000/v1/models

# Test STT (auto-detects language)
curl -X POST http://localhost:8000/v1/audio/transcriptions \
  -F "file=@test.ogg" \
  -F "model=Systran/faster-whisper-small"

# Test TTS (English)
curl -X POST http://localhost:8000/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"speaches-ai/Kokoro-82M-v1.0-ONNX","voice":"af_heart","input":"Hello world"}' \
  --output test_en.mp3

# Test TTS (Spanish)
curl -X POST http://localhost:8000/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"speaches-ai/Kokoro-82M-v1.0-ONNX","voice":"ef_dora","input":"Hola mundo"}' \
  --output test_es.mp3
```
