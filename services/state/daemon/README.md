# @kb-labs/state-daemon

HTTP daemon server for persistent cross-invocation state in KB Labs.

## Overview

State Daemon provides a lightweight HTTP server for state shared across CLI
invocations. A host-managed daemon keeps unexpired values in an append-only
journal under the platform data root; a standalone daemon without a supplied
platform data root uses in-memory storage.

### Features

- **Fastify-based HTTP server**: Uniform service foundation across KB Labs
- **Host-managed journal**: Values survive daemon and host restarts
- **Standalone in-memory storage**: Fast key-value operations (~1ms)
- **Automatic TTL cleanup**: Background cleanup every 30s
- **HTTP REST API**: Simple GET/PUT/DELETE endpoints
- **Namespace isolation**: Per-plugin namespaces with statistics
- **Observability contract**: `/health`, `/stats`, `/metrics`, `/observability/describe`, `/observability/health`
- **Graceful shutdown**: SIGTERM/SIGINT handling

Each host-managed mutation is appended and `fsync`ed before its StateBroker
promise resolves. A resolved write has no process-crash loss window. A write
whose promise has not resolved may be absent after a crash; a host or power
failure may also lose the latest write if storage does not honor `fsync`.
Expiry is stored as an absolute wall-clock deadline and is not extended by a
restart. Omitting `ttl` retains the current five-minute default.

## Installation

```bash
pnpm add @kb-labs/state-daemon
```

## Usage

### Start Daemon

```bash
# Standalone daemon: choose a port explicitly
KB_STATE_DAEMON_PORT=7777 kb-state-daemon

# Custom port
KB_STATE_DAEMON_PORT=8888 kb-state-daemon

# Custom host (be careful with security!)
KB_STATE_DAEMON_HOST=0.0.0.0 KB_STATE_DAEMON_PORT=7777 kb-state-daemon
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `KB_STATE_DAEMON_PORT` | Required for standalone runs; assigned by the host in host-managed runs | HTTP server port |
| `KB_STATE_DAEMON_HOST` | `localhost` | HTTP server host (use `0.0.0.0` for network access) |

### Programmatic Usage

```typescript
import { StateDaemonServer } from '@kb-labs/state-daemon';

const server = new StateDaemonServer({
  port: 7777,
  host: 'localhost',
});

await server.start();
console.log('State daemon running on localhost:7777');

// Graceful shutdown
process.on('SIGTERM', () => {
  void server.stop();
});
```

Host-managed startup supplies the data root resolved from the platform layout
contract. Standalone examples above omit that host-owned value and therefore
keep state in memory.

## HTTP API

### Health Check

```bash
GET /health
```

**Response:**

```json
{
  "status": "ok",
  "version": "0.1.0",
  "stats": {
    "uptime": 123456,
    "totalEntries": 42,
    "totalSize": 1024,
    "hitRate": 0.85,
    "missRate": 0.15,
    "evictions": 5,
    "namespaces": {
      "mind": {
        "entries": 30,
        "sizeBytes": 768,
        "lastAccess": 1638360000000
      },
      "workflow": {
        "entries": 12,
        "sizeBytes": 256,
        "lastAccess": 1638360000000
      }
    }
  }
}
```

### Get Statistics

```bash
GET /stats
```

**Response:** Same as health stats.

### Metrics Snapshot

```bash
GET /metrics
```

Prometheus-compatible snapshot with canonical process and service metric families.

### Observability Describe

```bash
GET /observability/describe
```

Returns the versioned KB Labs observability contract descriptor for the service.

### Observability Health

```bash
GET /observability/health
```

Returns structured runtime diagnostics including checks, resource snapshot, top operations, and service state.

### Get Value

```bash
GET /state/:key
```

**Example:**

```bash
curl http://localhost:7777/state/mind:query-123
```

**Response (200 OK):**

```json
{
  "queryId": "Q-abc123",
  "result": { ... },
  "createdAt": "2025-11-29T12:00:00Z"
}
```

**Response (404 Not Found):**

```json
{
  "error": "NOT_FOUND",
  "message": "Key not found or expired"
}
```

### Set Value

```bash
PUT /state/:key
Content-Type: application/json

{
  "value": { ... },
  "ttl": 60000  // Optional TTL in milliseconds
}
```

**Example:**

```bash
curl -X PUT http://localhost:7777/state/mind:query-123 \
  -H "Content-Type: application/json" \
  -d '{
    "value": {"result": "cached data"},
    "ttl": 60000
  }'
```

**Response (204 No Content)**

### Delete Value

```bash
DELETE /state/:key
```

**Example:**

```bash
curl -X DELETE http://localhost:7777/state/mind:query-123
```

**Response (204 No Content)**

### Clear Values

```bash
POST /state/clear?pattern=<pattern>
```

**Examples:**

```bash
# Clear all entries
curl -X POST http://localhost:7777/state/clear

# Clear by namespace
curl -X POST http://localhost:7777/state/clear?pattern=mind:*

# Clear by prefix
curl -X POST http://localhost:7777/state/clear?pattern=mind:query-*
```

**Response (204 No Content)**

## Architecture

### In-Memory Storage

```typescript
// Stored as:
Map<string, CacheEntry>

interface CacheEntry {
  value: unknown;
  expiresAt: number;
  namespace: string;
  sizeBytes: number;
}
```

### TTL Cleanup

```typescript
// Every 30 seconds
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (now > entry.expiresAt) {
      store.delete(key);
      evictions++;
    }
  }
}, 30000);
```

### Namespace Extraction

Keys are automatically parsed into namespaces:

- `mind:query-123` → namespace: `mind`
- `workflow:job-456` → namespace: `workflow`
- `cache:session-789` → namespace: `cache`

Statistics are tracked per namespace.

## Performance

### Benchmarks

| Operation | Latency | Throughput |
|-----------|---------|------------|
| GET       | ~1ms    | ~1000 ops/s |
| PUT       | ~1ms    | ~1000 ops/s |
| DELETE    | ~0.5ms  | ~2000 ops/s |

**Note:** Localhost performance. Network latency adds ~0.1-0.5ms.

### Memory Usage

- **Overhead per entry:** ~100 bytes (key + metadata)
- **Default limit:** None (controlled by plugin quotas)
- **10,000 entries:** ~1 MB + data size

### Comparison with File I/O

| Operation | Daemon | File I/O | Improvement |
|-----------|--------|----------|-------------|
| Cache read | 1ms   | 10-50ms | 10-50x faster |
| Cache write | 1ms  | 10-50ms | 10-50x faster |

## Monitoring

### Health Endpoint

```bash
# Quick health check
curl -s http://localhost:7777/health | jq '.status'
# "ok"

# Full stats
curl -s http://localhost:7777/health | jq '.stats'
```

### Statistics

```json
{
  "uptime": 3600000,           // 1 hour
  "totalEntries": 1234,
  "totalSize": 5242880,        // ~5 MB
  "hitRate": 0.85,             // 85% cache hits
  "missRate": 0.15,            // 15% cache misses
  "evictions": 42,             // 42 entries evicted (expired)
  "namespaces": {
    "mind": {
      "entries": 1000,
      "sizeBytes": 4194304,    // ~4 MB
      "lastAccess": 1638360000000
    }
  }
}
```

## Lifecycle Management

### Manual Start/Stop

```bash
# Start
kb-state-daemon &
DAEMON_PID=$!

# Stop
kill $DAEMON_PID
```

### Systemd Service (Linux)

Create `/etc/systemd/system/kb-state-daemon.service`:

```ini
[Unit]
Description=KB Labs State Daemon
After=network.target

[Service]
Type=simple
User=youruser
Environment="KB_STATE_DAEMON_PORT=7777"
Environment="KB_STATE_DAEMON_HOST=localhost"
ExecStart=/usr/local/bin/kb-state-daemon
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable kb-state-daemon
sudo systemctl start kb-state-daemon
sudo systemctl status kb-state-daemon
```

### Launchd Service (macOS)

Create `~/Library/LaunchAgents/com.kb-labs.state-daemon.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.kb-labs.state-daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/kb-state-daemon</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>KB_STATE_DAEMON_PORT</key>
        <string>7777</string>
        <key>KB_STATE_DAEMON_HOST</key>
        <string>localhost</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/kb-state-daemon.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/kb-state-daemon.error.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.kb-labs.state-daemon.plist
launchctl start com.kb-labs.state-daemon
launchctl list | grep kb-state-daemon
```

## Security Considerations

### Network Access

**⚠️ Default: localhost only**

The daemon binds to `localhost` by default, preventing network access.

**❌ DO NOT expose to network without authentication:**

```bash
# INSECURE - allows network access without auth
KB_STATE_DAEMON_HOST=0.0.0.0 kb-state-daemon
```

### Authentication

Currently, no authentication is implemented. The daemon should only be used on trusted localhost.

**Future improvements:**
- API key authentication
- JWT tokens
- TLS/SSL support
- Rate limiting

### Namespace Isolation

Namespace isolation is enforced at the runtime level, not the daemon level. The daemon itself does not enforce permissions - it's a dumb key-value store.

**Permission enforcement:** Handled by `@kb-labs/plugin-runtime` via `createStateAPI()`.

## Troubleshooting

### Daemon Not Starting

```bash
# Check if port is already in use
lsof -i :7777

# Try custom port
KB_STATE_DAEMON_PORT=8888 kb-state-daemon
```

### Connection Refused

```bash
# Check if daemon is running
curl http://localhost:7777/health

# Check logs (if using systemd)
sudo journalctl -u kb-state-daemon -f

# Check logs (if using launchd)
tail -f /tmp/kb-state-daemon.log
```

### High Memory Usage

```bash
# Check stats
curl -s http://localhost:7777/stats | jq '.totalSize'

# Clear specific namespace
curl -X POST http://localhost:7777/state/clear?pattern=mind:*
```

### Slow Performance

Daemon performance should be ~1ms per operation on localhost. If slower:

1. **Network latency**: Check if using remote host instead of localhost
2. **Large payloads**: Check `totalSize` in stats (>100 MB may cause slowdown)
3. **System load**: Check CPU/memory usage

## API Client Libraries

### JavaScript/TypeScript

```typescript
import { createStateBroker } from '@kb-labs/core-state-broker';

const client = createStateBroker({ backend: 'http' });
await client.set('key', 'value', 60000);
const value = await client.get('key');
```

### Shell (curl)

```bash
# Helper functions
kb_state_get() {
  curl -s "http://localhost:7777/state/$1" | jq -r '.value'
}

kb_state_set() {
  curl -s -X PUT "http://localhost:7777/state/$1" \
    -H "Content-Type: application/json" \
    -d "{\"value\":\"$2\",\"ttl\":$3}"
}

kb_state_delete() {
  curl -s -X DELETE "http://localhost:7777/state/$1"
}

# Usage
kb_state_set "my-key" "my-value" 60000
kb_state_get "my-key"
kb_state_delete "my-key"
```

## Related Packages

- **@kb-labs/core-state-broker** - State Broker client library
- **@kb-labs/plugin-runtime** - Runtime integration with permissions
- **@kb-labs/plugin-manifest** - Permission type definitions

## License

MIT

## See Also

- [ADR-0037: State Broker for Persistent Cache](../../kb-labs-mind/docs/adr/0037-state-broker-persistent-cache.md)
- [State Broker README](../state-broker/README.md)
