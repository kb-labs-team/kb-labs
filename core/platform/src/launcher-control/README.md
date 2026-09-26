# Launcher control protocol, v1

The `kb-create` launcher serves a small JSON protocol on `127.0.0.1` (random
port) so that the host, and Studio through it, can ask for lifecycle operations
(ADR-0045). Go and TS share no code: this directory is the shared contract.

- Discovery: `control.json` in the launcher state directory (mode `0600`):
  `{protocol, address, token, pid, version}`. The launcher removes it on exit.
- Auth: `Authorization: Bearer <token>` on every request. Requests with an
  `Origin` header or a `Host` other than `address` are rejected. There is no CORS.
- Endpoints: `GET /v1/status`, `POST /v1/host/restart`, `POST /v1/update-request`.
- Errors: HTTP status plus `{ "ok": false, "error": <error envelope> }`, codes from
  `../error-envelope/errors.catalog.json` (`KB_HOST_CONTROL_UNAUTHORIZED`,
  `KB_RUNTIME_INPUT_INVALID`, ...).

## Fixtures

`fixtures/v1/*.json` are HTTP exchanges:

```json
{ "request": { "method", "path", "auth": "valid|wrong|none", "body?" },
  "response": { "status", "body" } }
```

`auth` selects the bearer token the client sends (`valid` = the token from
`control.json`). In `response.body`, string values starting with `$` are
matchers: `$string` (non-empty string), `$number`, `$iso8601` (RFC 3339
timestamp). Everything else must be equal, and objects must have exactly the
listed keys. `control-file.json` describes `control.json` with the same matchers.

The Go side (`TestSharedProtocolFixtures` in `tools/kb-create/v2/control/control_test.go`) replays every
fixture against a real server with a fake host. A TS client test should replay
the same files against its own client or a mock server.

State assumed by every exchange: the host is running and the update-request
queue is empty (each exchange runs against a fresh launcher).
