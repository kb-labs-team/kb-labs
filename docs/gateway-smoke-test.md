# Gateway Smoke Test

Manual smoke test for the KB Labs gateway. Works against local (`http://localhost:4000`) or remote (`https://api.kblabs.ru`).

Set `BASE` before running any commands:

```bash
BASE=https://api.kblabs.ru
# or
BASE=http://localhost:4000
```

---

## 1. Health

```bash
curl -s $BASE/health | jq '.data'
```

Expected under `data`: `status: "healthy"`, all adapters `available: true`. Upstreams (rest, workflow, marketplace) may be down if not deployed — that's separate from gateway health.

---

## 2. Auth

### Register

```bash
curl -s -X POST $BASE/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"test","capabilities":[]}' | jq .
```

Expected: `{ clientId, clientSecret, hostId, namespaceId }`.

> `namespaceId` is server-assigned — do not supply it in the request. `clientSecret` is returned once and never stored server-side; save it immediately.

### Get token

```bash
TOKEN=$(curl -s -X POST $BASE/auth/token \
  -H "Content-Type: application/json" \
  -d '{"clientId":"<clientId>","clientSecret":"<clientSecret>"}' | jq -r '.accessToken')
echo $TOKEN
```

All subsequent requests use `Authorization: Bearer $TOKEN`.

---

## 3. Platform adapters

All adapters follow the same pattern:

```
POST /platform/v1/<adapter>/<method>
Body: { "args": [...positional args...] }
```

To discover the methods exposed by the Gateway, request the authenticated
catalog. Its `data.adapters` object is derived from the same allowlist enforced
by platform adapter calls:

```bash
curl -s $BASE/platform/v1/adapters \
  -H "Authorization: Bearer $TOKEN" | jq '.data.adapters'
```

### LLM

```bash
# complete
curl -s -X POST $BASE/platform/v1/llm/complete \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"args":["Say hello in one word",{"maxTokens":10}]}' | jq .

# chatWithTools (tools array can be empty)
curl -s -X POST $BASE/platform/v1/llm/chatWithTools \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"args":[[{"role":"user","content":"What is 2+2?"}],[],{}]}' | jq .
```

Expected: `ok: true`, `result.content` has text, `result.model` is a real model name (not `mock-model`).  
If `model: "mock-model"` — LLM adapter is not configured with a real API key.

### Embeddings

```bash
curl -s -X POST $BASE/platform/v1/embeddings/embed \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"args":["hello world"]}' | jq '.ok, (.result | length)'
```

Expected: `ok: true`, result is an array of floats (length = model dimension, e.g. 384 or 1536).

### Cache

```bash
# set
curl -s -X POST $BASE/platform/v1/cache/set \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"args":["smoke-key","smoke-value",300]}' | jq .

# get — must return "smoke-value"
curl -s -X POST $BASE/platform/v1/cache/get \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"args":["smoke-key"]}' | jq .
```

Expected: `get` returns `result: "smoke-value"`. If `result: null` — cache is in-memory only and not persisting (Redis not configured).

### Analytics

```bash
# track
curl -s -X POST $BASE/platform/v1/analytics/track \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"args":["smoke.test",{"source":"manual"}]}' | jq .

# verify it was recorded
curl -s -X POST $BASE/platform/v1/analytics/getEvents \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"args":[{"eventType":"smoke.test","limit":1}]}' | jq '.result.events[0].type'

# stats
curl -s -X POST $BASE/platform/v1/analytics/getStats \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"args":[{}]}' | jq '.result.totalEvents, .result.byType'
```

Expected: `track` returns `ok: true`, `getEvents` returns the event you just sent, `getStats` shows counts by event type.

### VectorStore

```bash
# upsert
curl -s -X POST $BASE/platform/v1/vectorStore/upsert \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"args":[{"id":"smoke-1","vector":[0.1,0.2,0.3],"payload":{"text":"hello"}}]}' | jq .

# search — vector dimension must match collection config
curl -s -X POST $BASE/platform/v1/vectorStore/search \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"args":[{"vector":[0.1,0.2,0.3],"limit":3}]}' | jq .
```

Note: if Qdrant collection is configured for 1536 dimensions (OpenAI), a 3-dim vector will return `Bad Request`. Use a vector of the correct dimension.

---

## 4. Telemetry ingest

```bash
curl -s -X POST $BASE/telemetry/v1/ingest \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "events": [
      { "source": "smoke-test", "type": "user.signup", "payload": { "plan": "free" }, "tags": { "env": "test" } },
      { "source": "smoke-test", "type": "api.request", "tags": { "route": "/v1/chat", "status": "200" } }
    ]
  }' | jq .
```

Expected: `{ accepted: 2, rejected: 0 }`.

Validation checks:
- Empty `events` array → 400
- No auth → 401

---

## 5. LLM gateway (OpenAI-compatible)

```bash
curl -s -X POST $BASE/llm/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role":"user","content":"Say hi"}],
    "max_tokens": 20
  }' | jq .
```

Expected: OpenAI-format response with `choices[0].message.content`.

---

## What to flag

| Symptom | Likely cause |
|---|---|
| `model: "mock-model"` | LLM adapter not configured — missing `OPENAI_API_KEY` |
| `cache.get` returns `null` after `set` | Redis not configured — using in-memory cache |
| `vectorStore.search` Bad Request | Vector dimension mismatch vs collection config |
| Upstreams `down` in `/health` | rest-api / workflow / marketplace not deployed |
| `ok: false, ADAPTER_UNAVAILABLE` | Adapter not wired in gateway config |
