# @kb-labs/state-broker

Universal state broker abstraction for persistent cross-invocation state management in KB Labs.

## Overview

State Broker provides a unified interface for key-value storage with TTL support, enabling plugins to maintain persistent state across CLI command invocations.

### Features

- **Zero external dependencies**: Pure Node.js implementation
- **Multiple backends**: In-memory, HTTP client, host-managed append-only journal
- **Automatic TTL cleanup**: Background cleanup of expired entries
- **Graceful degradation**: Falls back to in-memory if daemon unavailable
- **Namespace isolation**: Permission-based access control
- **Statistics & monitoring**: Built-in metrics (hits, misses, evictions)

## Architecture

```
┌─────────────────────────────────┐
│  Application Code               │
│  ├─ QueryCache                  │
│  ├─ SessionManager              │
│  └─ ConfigCache                 │
└─────────────────────────────────┘
              ↓
┌─────────────────────────────────┐
│  StateBroker Interface          │
│  ├─ get<T>(key): Promise<T>     │
│  ├─ set<T>(key, value, ttl)     │
│  ├─ delete(key)                 │
│  ├─ clear(pattern)              │
│  └─ getStats()                  │
└─────────────────────────────────┘
       ↓              ↓
┌──────────────┐ ┌──────────────┐
│  In-Memory   │ │  HTTP Client │
│  Backend     │ │  (Daemon)    │
└──────────────┘ └──────────────┘
                      ↓
                ┌──────────────┐
                │ State Daemon │
                │ (localhost)  │
                └──────────────┘
                      ↓
                ┌──────────────┐
                │ Journal under│
                │ platform data│
                │ root          │
                └──────────────┘
```

## Installation

```bash
pnpm add @kb-labs/state-broker
```

## Usage

### Basic Usage (In-Memory)

```typescript
import { InMemoryStateBroker } from '@kb-labs/state-broker';

const broker = new InMemoryStateBroker();

// Set value with 60s TTL
await broker.set('user:123', { name: 'Alice' }, 60 * 1000);

// Get value
const user = await broker.get<{ name: string }>('user:123');
console.log(user); // { name: 'Alice' }

// Delete value
await broker.delete('user:123');

// Clear by pattern
await broker.clear('user:*');
```

### HTTP Client (Daemon Mode)

```typescript
import { createStateBroker } from '@kb-labs/core-state-broker';

const broker = createStateBroker({ backend: 'http' });

// Gracefully falls back to null if daemon unavailable
const cached = await broker.get('query-result');
if (cached) {
  console.log('Cache hit:', cached);
} else {
  console.log('Cache miss - daemon unavailable or expired');
}

// Set with TTL
await broker.set('query-result', result, 60 * 1000);
```

### Factory Pattern (Auto-detection)

```typescript
import { detectStateBroker } from '@kb-labs/state-broker';

// Automatically detects if daemon is available
const broker = await detectStateBroker();
// Returns HTTPStateBroker if daemon running, InMemoryStateBroker otherwise

await broker.set('key', 'value', 30 * 1000);
```

### Plugin Runtime Integration

```typescript
// In plugin handler (runtime.state is automatically configured)
export async function handler({ runtime }) {
  // Access own namespace automatically
  await runtime.state.set('query-123', result, 60 * 1000);

  // Get from own namespace
  const cached = await runtime.state.get('query-123');

  // Access external namespace (requires manifest permission)
  const shared = await runtime.state.get('other-plugin:config');
}
```

## API Reference

### `StateBroker` Interface

```typescript
interface StateBroker {
  /**
   * Get value by key
   * @returns Value or null if not found/expired
   */
  get<T>(key: string): Promise<T | null>;

  /**
   * Set value with optional TTL
   * @param key - Storage key
   * @param value - Value to store (must be JSON-serializable)
   * @param ttl - Time to live in milliseconds (optional)
   */
  set<T>(key: string, value: T, ttl?: number): Promise<void>;

  /**
   * Delete value by key
   */
  delete(key: string): Promise<void>;

  /**
   * Clear values by pattern
   * @param pattern - Glob pattern (e.g., 'user:*', 'cache:*')
   */
  clear(pattern?: string): Promise<void>;

  /**
   * Get broker statistics
   */
  getStats(): Promise<BrokerStats>;

  /**
   * Get health status
   */
  getHealth(): Promise<HealthStatus>;

  /**
   * Stop broker and cleanup
   */
  stop(): Promise<void>;
}
```

### `BrokerStats`

```typescript
interface BrokerStats {
  uptime: number;              // Milliseconds since start
  totalEntries: number;        // Current entry count
  totalSize: number;           // Total size in bytes
  hitRate: number;             // Cache hit rate (0-1)
  missRate: number;            // Cache miss rate (0-1)
  evictions: number;           // Total evictions
  namespaces: Record<string, NamespaceStats>;
}

interface NamespaceStats {
  entries: number;
  sizeBytes: number;
  lastAccess: number;
}
```

### `HealthStatus`

```typescript
interface HealthStatus {
  status: 'ok' | 'degraded' | 'error';
  version: string;
  stats: BrokerStats;
}
```

## Backends

### InMemoryStateBroker

**Use case:** Development, testing, fallback when daemon unavailable.

**Features:**
- ✅ No external dependencies
- ✅ Automatic TTL cleanup (every 30s)
- ✅ Fast (in-memory Map)
- ❌ Lost on process restart
- ❌ Not shared across processes

**Configuration:**

```typescript
const broker = new InMemoryStateBroker(
  cleanupIntervalMs: 30_000 // Cleanup interval (default: 30s)
);
```

### HTTPStateBroker

**Use case:** Host-managed StateDaemon access across invocations.

**Features:**
- ✅ Values with unexpired TTL survive StateDaemon and host restarts
- ✅ Shared across processes
- ✅ Mutations are appended and synced before the StateBroker promise resolves
- ✅ Graceful degradation if daemon down
- ❌ Requires daemon process
- ❌ Network overhead (~0.1-0.5ms on localhost)

**Configuration:**

```typescript
// Host-managed runtimes resolve the StateBroker address from their launch environment.
import { createStateBroker } from '@kb-labs/core-state-broker';

const broker = createStateBroker({ backend: 'http' });
```

The host resolves the platform data root from the platform layout contract and
passes it to StateDaemon. The daemon stores its journal below
`<platform-data-root>/state-broker/`. Journal records keep absolute wall-clock
expiry timestamps, so restarting the daemon does not extend a value's TTL.
Omitting `ttl` continues to use the existing five-minute default.

Each mutation is appended and `fsync`ed before its promise resolves. A resolved
write has no process-crash loss window. A write still in progress when a process
crashes may be absent; a host or power failure can also lose the latest write
if the filesystem or storage device does not honor `fsync`.

## Error Handling

### Graceful Degradation

HTTP client silently returns `null` on connection errors:

```typescript
const broker = createStateBroker({ backend: 'http' });

// Daemon down - returns null instead of throwing
const value = await broker.get('key'); // null

// Daemon down - silently fails (no-op)
await broker.set('key', 'value'); // No error thrown
```

### Error Cases

```typescript
// Daemon running but returns error
try {
  await broker.get('key');
} catch (error) {
  console.error('Broker error:', error.message);
  // Handle error (not connection failure)
}
```

## Performance

### Benchmarks

| Operation | In-Memory | HTTP (localhost) | File I/O |
|-----------|-----------|------------------|----------|
| get()     | ~0.01ms   | ~1ms            | ~10-50ms |
| set()     | ~0.01ms   | ~1ms            | ~10-50ms |
| delete()  | ~0.01ms   | ~1ms            | ~10-50ms |

**Expected improvement over file-based cache:** 10-50x faster

### Memory Usage

- **Per entry overhead:** ~100 bytes (key + metadata)
- **Default quota:** 100 MB per plugin (configurable)
- **10,000 entries:** ~1 MB + data size

## Integration with Plugin Permissions

### Manifest Declaration

```typescript
// manifest.v2.ts
permissions: {
  state: {
    own: {
      read: true,
      write: true,
      delete: true,
    },
    external: [
      {
        namespace: 'other-plugin',
        read: true,
        write: false,
        delete: false,
        reason: 'Need to read shared configuration'
      }
    ],
    quotas: {
      maxEntries: 10000,
      maxSizeBytes: 100 * 1024 * 1024, // 100 MB
      operationsPerMinute: 1000,
    },
  },
}
```

### Runtime Usage

```typescript
// Automatic namespace prefixing
await runtime.state.set('key', value);
// Stored as: 'my-plugin:key'

// External namespace (requires permission)
await runtime.state.get('other-plugin:config');
// Permission check enforced
```

## Migration from File-based Cache

### Before

```typescript
// Old file-based cache
const cache = await readJson('.kb/cache.json') || {};
cache['key'] = { value, createdAt: Date.now() };
await writeJson('.kb/cache.json', cache);
```

### After

```typescript
// New StateBroker
const broker = await detectStateBroker();
await broker.set('key', value, 60 * 1000);
const cached = await broker.get('key');
```

### Backward Compatible

```typescript
export class QueryCache {
  constructor(cwd: string, broker?: StateBrokerLike) {
    this.broker = broker;
  }

  async get(key: string) {
    // Use broker if available
    if (this.broker) {
      return this.broker.get(key);
    }

    // Fallback to file-based cache
    const cache = await readJson(this.cacheFile);
    return cache[key];
  }
}
```

## Related Packages

- **@kb-labs/state-daemon** - HTTP daemon server for persistent state
- **@kb-labs/plugin-runtime** - Runtime integration with permission checks
- **@kb-labs/plugin-manifest** - Permission type definitions

## License

MIT

## See Also

- [ADR-0037: State Broker for Persistent Cache](../../kb-labs-mind/docs/adr/0037-state-broker-persistent-cache.md)
- [State Daemon README](../state-daemon/README.md)
