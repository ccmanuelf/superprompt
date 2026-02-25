# Local Voice — Speaches + Piper TTS + Faster-whisper STT

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
│  │  Piper               │  (TTS engine) │
│  └─────────────────────┘                │
└─────────────────────────────────────────┘
```

- Single Docker container provides both STT and TTS
- API is OpenAI-compatible — use the `openai` npm package
- Models are cached in a Docker volume (persist across restarts)

---

## Docker Compose Configuration

### `docker/speaches.yml`

```yaml
services:
  speaches:
    image: speaches/speaches:latest
    container_name: clauded-speaches
    ports:
      - "127.0.0.1:8000:8000"
    volumes:
      - speaches-models:/root/.cache
    environment:
      - WHISPER_MODEL=whisper-small
      - PIPER_VOICE=en_US-lessac-medium
    healthcheck:
      test: ["CMD", "curl", "-fSs", "http://localhost:8000/health"]
      interval: 15s
      timeout: 5s
      retries: 3
      start_period: 60s  # Models need time to load on first start
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 2G  # whisper-small uses ~850MB, Piper ~200MB

volumes:
  speaches-models:
```

---

## Model Choices

### STT: whisper-small
- **Size**: ~850MB RAM when loaded
- **Speed**: ~3-6 seconds for 30 seconds of audio (on Apple Silicon)
- **Quality**: Good accuracy for English, acceptable for other languages
- **Alternative**: `whisper-base` if memory is tight (~400MB, slightly lower quality)
- **Alternative**: `whisper-medium` for better quality (~1.5GB, ~6-10s processing)

### TTS: Piper with en_US-lessac-medium
- **Size**: ~63MB model file
- **Speed**: ~500ms synthesis for a paragraph
- **Quality**: Natural-sounding, good prosody
- **Format**: Outputs WAV, convert to OGG/MP3 for messaging
- **Alternative voices**: `en_US-amy-medium`, `en_GB-alan-medium`

---

## Implementation (`src/voice.ts`)

### STT — Transcribe Audio

```typescript
import OpenAI from 'openai';
import fs from 'node:fs';
import path from 'node:path';

const speachesClient = new OpenAI({
  baseURL: config.SPEACHES_URL || 'http://localhost:8000/v1',
  apiKey: 'not-needed', // Speaches doesn't require auth
});

export async function transcribeAudio(audioPath: string): Promise<string> {
  // GOTCHA: Telegram sends .oga, whisper needs .ogg
  // They're the same format, just different extension
  let finalPath = audioPath;
  if (audioPath.endsWith('.oga')) {
    finalPath = audioPath.replace(/\.oga$/, '.ogg');
    fs.renameSync(audioPath, finalPath);
  }

  const transcription = await speachesClient.audio.transcriptions.create({
    file: fs.createReadStream(finalPath),
    model: 'whisper-small',
    language: 'en', // Set explicitly for better accuracy
  });

  return transcription.text;
}
```

### TTS — Synthesize Speech

```typescript
export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const response = await speachesClient.audio.speech.create({
    model: 'piper',
    voice: 'en_US-lessac-medium',
    input: text,
    response_format: 'mp3',
  });

  // Response is a ReadableStream, convert to Buffer
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
  try {
    const response = await fetch(
      `${config.SPEACHES_URL || 'http://localhost:8000'}/health`
    );
    if (response.ok) {
      return { stt: true, tts: true };
    }
  } catch {
    // Speaches not reachable
  }
  return { stt: false, tts: false };
}
```

---

## Integration with Messaging Platforms

### Telegram Voice Notes
1. User sends voice note → Telegram delivers `.oga` file
2. Bot downloads via `bot.api.getFile(file_id)` → saves to `workspace/uploads/`
3. Call `transcribeAudio(filePath)` → get text
4. Prepend `[Voice transcribed]: ` to message, process normally
5. If `forceVoiceReply` is set, call `synthesizeSpeech(response)` → send as voice note

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

1. **Cold start latency**: First request after container start takes 10-30s while models load. The health check with `start_period: 60s` handles this.

2. **OGA → OGG rename**: Telegram voice notes use `.oga` extension. Faster-whisper requires `.ogg`. They are the same Opus codec in Ogg container — just rename.

3. **Memory usage**: whisper-small holds ~850MB in RAM permanently. Piper loads models on demand (~200MB per voice). Total: ~1-1.5GB for the Speaches container.

4. **Audio format**: Speaches STT accepts: wav, mp3, ogg, flac, webm. Speaches TTS outputs: mp3, wav, ogg, flac.

5. **Language detection**: Setting `language: 'en'` explicitly improves accuracy and speed. Without it, whisper runs language detection first.

6. **Long audio**: Faster-whisper handles long audio well (uses VAD for chunking). No need to split audio manually.

7. **Concurrent requests**: Speaches handles one request at a time per model. For a single-user bot, this is fine. STT and TTS can run concurrently since they're different models.

---

## Testing

### Manual Test
```bash
# Check Speaches is running
curl http://localhost:8000/health

# Test STT
curl -X POST http://localhost:8000/v1/audio/transcriptions \
  -F "file=@test.ogg" \
  -F "model=whisper-small"

# Test TTS
curl -X POST http://localhost:8000/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"piper","voice":"en_US-lessac-medium","input":"Hello world"}' \
  --output test.mp3
```

### Unit Test (Mocked)
```typescript
// Mock the openai client
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    audio: {
      transcriptions: {
        create: vi.fn().mockResolvedValue({ text: 'Hello world' }),
      },
      speech: {
        create: vi.fn().mockResolvedValue({
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
        }),
      },
    },
  })),
}));
```
