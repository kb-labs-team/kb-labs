# Gateway & Execution Architecture

> **Status:** Experiment — Phase 1 complete, Phase 2 not started
> **Last Updated:** 2026-04-26
> **Context:** First cloud migration experiment. Goal: run plugins/agents remotely, CLI stays local.

---

## Vision

KB Labs CLI выполняет плагины и агентов **удалённо** — на облачных машинах или выделенных воркерах. CLI не знает где физически запускается код. Gateway — единая точка входа и маршрутизации.

```
CLI (локально) → Gateway → Host Agent (где угодно) → выполняет плагин
```

Это позволяет:
- Запускать тяжёлые агентов в облаке, не нагружая локальную машину
- Иметь несколько воркеров и балансировать между ними
- Изолировать выполнение (каждый tenant — свой host)
- Работать с одного CLI с нескольких машин

---

## Текущая Архитектура (Phase 1)

### Компоненты

```
┌─────────────────────────────────────────────────────────────────┐
│  CLI (kb-labs-cli)                                               │
│                                                                  │
│  resolveTransport()                                             │
│    1. ~/.kb/agent.sock живой?  → HostAgentTransport (IPC)       │
│    2. credentials.json есть?   → HttpSseGatewayTransport (HTTP) │
│    3. иначе                    → Error "run kb auth login"      │
└───────────┬──────────────────────────┬──────────────────────────┘
            │ IPC (unix socket)        │ HTTP
            ▼                         ▼
┌───────────────────────┐   ┌─────────────────────────────────────┐
│  Host Agent daemon    │   │  Gateway :4000 (kb-labs-gateway)    │
│  (~/.kb/agent.sock)   │   │                                     │
│                       │   │  Auth:   JWT (15min) + refresh      │
│  - TokenManager       │   │  Routes: /auth/*, /hosts/*, /health │
│  - GatewayClient (WS) │   │          POST /api/v1/execute       │
│  - IpcServer          │   │                                     │
│  - FilesystemHandler  │   │  Proxy:  /api/v1/* → REST :5050    │
│                       │   │          /api/exec/* → Workflow :7778│
└───────┬───────────────┘   └──────────────┬──────────────────────┘
        │                                  │
        │ POST /api/v1/execute             │ WebSocket
        └─────────────────────────────────►│
                                           │ call('execution', ...)
                                           ▼
                                   Host Agent (WS client)
                                   handler('execution') → ExecutionHandler ✅
```

### Реализованные компоненты

| Компонент | Статус | Пакет |
|-----------|--------|-------|
| Gateway сервер (Fastify) | ✅ | `plugins/gateway/app` |
| JWT аутентификация | ✅ | `plugins/gateway/auth` |
| WebSocket хендшейк (hosts/clients) | ✅ | `gateway-ws.ts` |
| Dispatcher (маршрутизация по namespaceId) | ✅ | `hosts/dispatcher.ts` |
| POST /api/v1/execute (ndjson streaming) | ✅ | `execute/routes.ts` |
| Execution registry + cancellation | ✅ | `execute/execution-registry.ts` |
| Host Agent daemon | ✅ | `services/host-agent/app` |
| Host Agent IPC сервер | ✅ | `host-agent-core/src/ipc` |
| Host Agent → Gateway tunnel | ✅ | `gateway-client.ts` → `executeTunnel()` |
| FilesystemHandler | ✅ | `services/host-agent/fs` |
| ExecutionHandler в Host Agent | ✅ | `host-agent-app/src/handlers/execution-handler.ts` |
| CLI transport resolver | ✅ | `cli/runtime/src/gateway/transport-resolver.ts` |
| Hosts registry фильтрация по namespaceId | ✅ | `HostRegistry.list(namespaceId)` |
| Token refresh в CLI | ✅ | `credentials.ts` + 401 auto-retry в `http-sse-transport.ts` |
| Transport resolver уважает `execution.mode` | ✅ | `bootstrap.ts` `dispatchPlugin` |

---

## Auth Model

### Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/auth/register` | POST | None | Register new client → `{ clientId, clientSecret, hostId, namespaceId }` |
| `/auth/token` | POST | None | Exchange credentials → JWT pair (access 15m + refresh 30d) |
| `/auth/refresh` | POST | None | Rotate token pair (single-use refresh token rotation) |
| `/hosts/connect` | WS | Bearer | Host Agent WebSocket tunnel |
| `/clients/connect` | WS | Bearer | Studio live-update WebSocket |
| `/internal/*` | POST | `x-internal-secret` | Gateway-to-service dispatch, not publicly accessible |

### namespaceId Isolation

`namespaceId` is the **tenant isolation key**. It is server-assigned at registration via `randomBytes(16).toString('hex')` — never accepted from client input.

Every authenticated request carries `namespaceId` in the JWT payload. The gateway injects it into `AuthContext` and all data-scoped operations (host dispatch, plugin calls) filter by it:

```
Client registers → namespaceId assigned server-side
     ↓
JWT payload: { sub: hostId, namespaceId, tier, type }
     ↓
AuthContext on every request: { userId, namespaceId, tier, permissions }
     ↓
Dispatcher: globalDispatcher.firstHost(auth.namespaceId)
     → only hosts registered in the same namespace are visible
```

This prevents cross-tenant host access even if a client guesses another tenant's `hostId`.

### AuthContext Injection

The auth middleware runs on every non-whitelisted route. On success it writes `AuthContext` to `request.authContext`:

```typescript
interface AuthContext {
  type: 'machine' | 'user' | 'cli';
  userId: string;       // hostId (JWT sub)
  namespaceId: string;
  tier: 'free' | 'pro' | 'enterprise';
  permissions: string[];
}
```

Routes that need auth call `request.authContext` directly — no additional middleware required.

### Refresh Token Rotation

Refresh tokens are single-use. On each `/auth/refresh` call:

1. JWT signature verified (`verifyRefreshToken`)
2. Token consumed from store by `jti` — **deleted atomically** (`consumeRefreshToken`)
3. If step 2 returns `null` (token already used or expired) → 401
4. New access + refresh token pair issued
5. New refresh token saved to store with TTL (30 days)

A replayed refresh token is rejected at step 2. This limits the damage window if a refresh token is stolen — the legitimate client's next refresh will also fail, making the theft detectable.

---

## Потоки данных

### IPC путь (host-agent запущен локально)

```
pnpm kb agent:run
    │
    ▼
resolveTransport() → ~/.kb/agent.sock живой → HostAgentTransport
    │
    │ IPC (unix socket)
    ▼
IpcServer.handleExecute()
    │
    │ executeTunnel()
    ▼
POST http://localhost:4000/api/v1/execute
    Bearer: <machine JWT>
    Body: { pluginId, handlerRef, exportName, input }
    │
    ▼
Gateway: auth middleware → authContext ✅
    │
    ▼
globalDispatcher.firstHost(namespaceId)
    → находит host_89dcd... (online)
    │
    │ WebSocket message: { type: 'call', adapter: 'execution', ... }
    ▼
Host Agent GatewayClient.onMessage()
    → handlers.get('execution') → ExecutionHandler.handle(call) ✅
```

### HTTP путь (host-agent не запущен)

```
pnpm kb agent:run
    │
    ▼
resolveTransport() → сокет мёртв → HttpSseGatewayTransport
    │
    │ POST http://localhost:4000/api/v1/execute
    │ Bearer: <user JWT из credentials.json>
    ▼
Gateway: auth middleware → authContext ✅
    │
    ▼
globalDispatcher.firstHost(namespaceId)
    → нет онлайн хостов → 503 "No host connected"
```

---

## Известные ограничения

### clientSecret в открытом виде (dev only)

**Файл:** `~/.kb/agent.json`

`clientSecret` хранится plaintext. Для dev — приемлемо, для prod — нет. Полное решение: зашифрованное хранилище (Keychain / Secret Service) при установке prod host-agent.

---

## Закрытые задачи (история)

| Задача | Статус | Когда |
|--------|--------|-------|
| `execution` handler в host-agent | ✅ реализован | — |
| Auth middleware PROXY_PREFIXES skip | ✅ удалён | 2026-03-15 |
| Hosts registry фильтрация по namespaceId | ✅ `HostRegistry.list(ns)` фильтрует | — |
| Token refresh в CLI | ✅ авто-рефреш + retry на 401 | — |
| Transport resolver уважает `execution.mode` | ✅ `dispatchPlugin` проверяет mode перед gateway | 2026-04-26 |

---

### Phase 4: Remote host (приоритет: низкий, "облако")

**Цель:** host-agent запущен на облачной машине, CLI — локально.

**4.1** Docker образ для host-agent

Use the Node.js major declared by the root `package.json` `engines.node` for
the platform runtime image:

```dockerfile
FROM node:<PLATFORM_NODE_MAJOR>-slim
COPY dist/ /app/dist/
CMD ["node", /app/dist/index.js]
```

**4.2** `kb agent register --gateway-url=https://my-gateway.com`

Регистрирует host-agent на удалённом gateway, сохраняет credentials.

**4.3** TLS для Gateway

Сейчас Gateway работает только на HTTP. Для remote нужен HTTPS (nginx reverse proxy + Let's Encrypt).

**4.4** Изоляция воркеров

Каждый вызов `execution` — в отдельном процессе/контейнере. Сейчас нет изоляции между выполнениями.

---

## Быстрые победы (можно сделать сейчас)

Все быстрые победы реализованы. Смотри раздел «Закрытые задачи» выше.
