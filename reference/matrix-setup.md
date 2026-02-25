# Matrix Self-Hosting — Synapse Setup & Bot SDK

## Architecture Overview

```
┌─────────────────────────────┐
│  Docker Compose             │
│                             │
│  ┌───────────┐              │
│  │  Synapse   │ port 8008   │
│  │  (Matrix)  │ localhost   │
│  └─────┬─────┘              │
│        │                    │
│  ┌─────┴─────┐              │
│  │  clauded   │             │
│  │  (bot)     │             │
│  └───────────┘              │
└─────────────────────────────┘
```

- Synapse runs alongside the bot in docker-compose
- Port 8008 exposed only to localhost (not public)
- Federation disabled — personal use, no external servers
- SQLite backend (sufficient for single-user, avoids Postgres dependency)

---

## Synapse Docker Configuration

### `docker/synapse/docker-compose.synapse.yml`

```yaml
services:
  synapse:
    image: matrixdotorg/synapse:latest
    container_name: clauded-synapse
    volumes:
      - synapse-data:/data
      - ./homeserver.yaml:/data/homeserver.yaml:ro
    ports:
      - "127.0.0.1:8008:8008"
    environment:
      - SYNAPSE_CONFIG_PATH=/data/homeserver.yaml
    healthcheck:
      test: ["CMD", "curl", "-fSs", "http://localhost:8008/health"]
      interval: 15s
      timeout: 5s
      retries: 3
    restart: unless-stopped

volumes:
  synapse-data:
```

### `docker/synapse/homeserver.yaml` (key settings)

```yaml
server_name: "clauded.local"
pid_file: /data/homeserver.pid
public_baseurl: "http://localhost:8008/"

listeners:
  - port: 8008
    tls: false
    type: http
    x_forwarded: false
    resources:
      - names: [client, federation]
        compress: false

database:
  name: sqlite3
  args:
    database: /data/homeserver.db

# CRITICAL: Disable federation for personal use
federation_domain_whitelist: []
allow_public_rooms_over_federation: false

# Allow registration only during setup (disable after)
enable_registration: false
enable_registration_without_verification: false

# Rate limiting (relaxed for personal use)
rc_message:
  per_second: 10
  burst_count: 50

# Media storage
media_store_path: /data/media_store
max_upload_size: 50M

# Logging
log_config: "/data/clauded.local.log.config"

# Signing key (auto-generated on first run)
signing_key_path: "/data/clauded.local.signing.key"

# Trusted key servers (empty since no federation)
trusted_key_servers: []
suppress_key_server_warning: true
```

---

## Bot Account Setup

### Initial Setup Script (`scripts/setup-matrix.ts`)

1. Start Synapse container
2. Generate Synapse config if not exists: `docker exec synapse generate`
3. Register admin account: `docker exec synapse register_new_matrix_user -c /data/homeserver.yaml -a -u admin -p <password>`
4. Register bot account: `register_new_matrix_user -u clauded-bot -p <password>`
5. Get bot access token via login API:
   ```
   POST http://localhost:8008/_matrix/client/r0/login
   {
     "type": "m.login.password",
     "user": "clauded-bot",
     "password": "<password>"
   }
   ```
6. Save access token to .env as `MATRIX_ACCESS_TOKEN`
7. Create a room for bot communication
8. Disable registration in homeserver.yaml

---

## Bot SDK Usage (`@vector-im/matrix-bot-sdk`)

### Initialization

```typescript
import {
  MatrixClient,
  SimpleFsStorageProvider,
  AutojoinRoomsMixin,
  RichConsoleLogger,
  LogService,
} from '@vector-im/matrix-bot-sdk';

function createMatrixBot(): MatrixClient {
  const homeserverUrl = config.MATRIX_HOMESERVER; // http://localhost:8008
  const accessToken = config.MATRIX_ACCESS_TOKEN;

  const storage = new SimpleFsStorageProvider(
    path.join(STORE_DIR, 'matrix-bot.json')
  );

  const client = new MatrixClient(
    homeserverUrl,
    accessToken,
    storage
  );

  // Auto-join rooms when invited
  AutojoinRoomsMixin.setupOnClient(client);

  return client;
}
```

### Event Handling

```typescript
client.on('room.message', async (roomId: string, event: any) => {
  // Ignore own messages
  if (event.sender === await client.getUserId()) return;

  // Ignore non-text messages (handle m.audio, m.image separately)
  if (event.content?.msgtype !== 'm.text') return;

  // Ignore messages from before bot started
  if (event.origin_server_ts < startTime) return;

  const body = event.content.body;
  const senderId = event.sender;

  // Auth check
  if (!isAuthorised(senderId)) return;

  // Process message...
  const response = await handleMessage(body, roomId);

  // Send response as m.notice (prevents bot loops)
  await client.sendMessage(roomId, {
    msgtype: 'm.notice',
    body: response.text,
    format: 'org.matrix.custom.html',
    formatted_body: formatForMatrix(response.text),
  });
});
```

### Key Patterns

1. **m.notice vs m.text**: Bot responses MUST be `m.notice` to prevent bot-to-bot loops. Other bots typically ignore `m.notice` events.

2. **Formatted body**: Matrix supports HTML via `org.matrix.custom.html` format. Use `formatted_body` for rich responses alongside plain `body` for fallback.

3. **Storage provider**: `SimpleFsStorageProvider` persists sync tokens to disk. This ensures the bot doesn't re-process old messages on restart.

4. **Start time filter**: Store `Date.now()` at startup and ignore events with `origin_server_ts` before it. Prevents processing historical messages.

5. **Room ID as chat ID**: Use the Matrix room ID (`!abc:clauded.local`) as the chat ID for sessions, memory, etc.

---

## Commands (Matrix uses `!` prefix)

| Command | Description |
|---------|-------------|
| `!newchat` | Clear session for this room |
| `!claude` | Switch to Claude provider |
| `!ollama` | Switch to Ollama provider |
| `!ollama:model` | Switch to specific Ollama model |
| `!memory` | Show stored memories |
| `!voice` | Toggle voice mode |
| `!schedule` | Manage scheduled tasks |

---

## Voice Messages in Matrix

Matrix voice messages are `m.audio` events with:
- `msgtype: "m.audio"`
- `info.mimetype`: usually `audio/ogg; codecs=opus`
- `url`: `mxc://` URL for the audio file

Download via: `GET /_matrix/media/r0/download/{serverName}/{mediaId}`

The bot SDK provides: `client.downloadContent(mxcUrl)` → returns Buffer.

---

## E2EE Notes (Future)

Currently NOT implementing E2EE because:
- Self-hosted Synapse with federation disabled = data stays local
- E2EE with bot SDK requires `@matrix-org/matrix-sdk-crypto-wasm` or Pantalaimon proxy
- Significant complexity for no security gain in isolated deployment

If E2EE is needed later:
1. Use Pantalaimon as a proxy (simplest approach)
2. Or integrate `matrix-sdk-crypto-wasm` (native WASM crypto)
3. Bot needs to verify devices and handle key backup

---

## Client Access

Users can connect to the self-hosted Synapse with:
- **Element Web**: Point at `http://localhost:8008`
- **Element Desktop/Mobile**: Add custom homeserver `http://<mac-ip>:8008`
- **FluffyChat**, **Nheko**, or any Matrix client

For mobile access outside the home network, options:
1. Tailscale/WireGuard VPN (recommended — zero config, secure)
2. Reverse proxy with TLS (Caddy/nginx + Let's Encrypt)
