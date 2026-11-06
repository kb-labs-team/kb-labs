# kb-runner

`kb-runner` coordinates agent jobs and tracks their provider usage. Codex is the default vendor. z.ai is an explicit reserve: it runs only when `agent start --vendor zai` is supplied, and it is never selected automatically or used as a fallback.

## Run an explicit z.ai job

The z.ai vendor uses the installed Claude Code CLI and the Anthropic-compatible GLM Coding Plan endpoint. Create an owner-only key file and point the runner at its path. Paste the key into the prompt; it is not accepted from an environment variable.

```sh
mkdir -p "$HOME/.config/kb-runner"
chmod 700 "$HOME/.config/kb-runner"
(umask 077; cat > "$HOME/.config/kb-runner/zai.key")
chmod 600 "$HOME/.config/kb-runner/zai.key"
export KB_RUNNER_ZAI_KEY_FILE="$HOME/.config/kb-runner/zai.key"
RUNNER_STATE="$HOME/.local/state/kb-runner"

kb-runner agent start \
  --vendor zai \
  --state "$RUNNER_STATE" \
  --stream reserve-task \
  --workdir "$PWD" \
  --prompt-file /path/to/prompt.md
```

The runner rejects a missing, empty, unreadable, non-regular, or group/other-accessible key file. z.ai jobs get a separate Claude config directory under the runner state directory. The default model mapping is Opus → `glm-5.3`, Sonnet → `glm-5.3`, and Haiku → `glm-5.3-flash`. Override an individual mapping with `ZAI_OPUS_MODEL`, `ZAI_SONNET_MODEL`, or `ZAI_HAIKU_MODEL`.

The endpoint and model IDs follow the [official z.ai documentation](https://zcode.z.ai/en/docs/configuration). The Anthropic endpoint applies to Coding Plan usage; it is not the general prepaid-balance endpoint.

## Record and inspect the spend grant

Record the owner’s grant once. The ledger adds input and output token usage from each z.ai job, keeps per-job totals, and shows the most recent job, total spend, and remaining grant in `limits`.

```sh
kb-runner limits record zai --state "$RUNNER_STATE" --grant 500M
kb-runner limits --state "$RUNNER_STATE"
```

The grant is a recorded ceiling for display. It does not participate in provider selection or automatic fallback. Claude and Codex recorded/vendor window pacing is unchanged.

## Run an explicit ZCode account job

ZCode uses its own account login and token store. Log in once with the same wrapper that `kb-runner` uses; the runner does not read or copy the credentials:

```sh
"$HOME/Desktop/work/zcode/zcode" login zai
RUNNER_STATE="$HOME/.local/state/kb-runner"

kb-runner agent start \
  --vendor zcode \
  --state "$RUNNER_STATE" \
  --stream zcode-reserve-task \
  --workdir "$PWD" \
  --prompt-file /path/to/prompt.md
```

`zcode` is available only when named with `--vendor zcode`; automatic selection and fallback never use it. Set `ZCODE_BIN` if the wrapper is elsewhere. The child environment points `ZCODE_DATA_BASE_DIR` to `$HOME/.zcode-kb-runner`, matching the wrapper's login data directory, and filters inherited Claude, Codex, Anthropic, and ZCode settings.

The Start Plan account selection is read from `$HOME/.zcode-kb-runner/.zcode/v2/provider_config.json`. For the owner's current setup it selects provider `account:zai-start-plan`, model `GLM-5.3`, and `options.reasoningLevel: "max"`. `kb-runner` does not pass a model flag or set a provider/model override, so the configured account selection is used.

ZCode runs in `yolo` mode for unattended work. The runner wraps it in macOS `sandbox-exec`; writes are allowed in the agent worktree, per-job temp directory, ZCode data directory, and Node/pnpm caches. Network access remains enabled for model requests. If the OS sandbox is unavailable or cannot apply its profile, the job is refused; it never runs unsandboxed.

The final ZCode `stream-json` result and `--json` summary include `usage.inputTokens` and `usage.outputTokens`; those values contribute to the per-job and vendor ledger. Record the grant shown in the account and inspect remaining tokens with:

```sh
kb-runner limits record zcode --state "$RUNNER_STATE" --grant 500M
kb-runner limits --state "$RUNNER_STATE"
```

The grant is accounting only and does not select or fall back to ZCode.

## Request a bounded Go test from an agent

`agent start` enables a per-job `kb-test` shim by default. From a Go module in the job worktree, request only a Go test run:

```sh
kb-test go -run '^TestX$' ./proc
```

The shim returns a JSON result with the exit code, pass/fail/skip counts, failing test names, a log tail capped at 64 KiB, and sandbox-denial lines. Each accepted request is admitted as a heavy runner process and appears in `kb-runner ps` and events with an `outside-test:<job-id>:<request-id>` tag. A job round accepts at most 20 requests, one at a time. The default timeout is 10 minutes; requests can set `-timeout` up to 20 minutes. Other tools and unsupported Go flags are refused with a typed runtime diagnostic.

The macOS execution profile allows process inspection, reads from the worktree, Go toolchain and runner-resolved shared module cache, writes in the worktree, fresh temporary HOME, and a state-owned Go build cache isolated by stream. The resolver honors runner-owned `HOME`, `GOPATH`, and `GOMODCACHE`, while disabling `GOENV`; it canonicalizes the result and requires an existing Go module cache containing `cache/download`. A cache that overlaps a denied secret root is refused. `GOMODCACHE` is read-only, `GOPROXY=off`, and `GOFLAGS=-mod=readonly`. Network access and runner credential paths are denied. Hygiene retains caches while a stream has an active runner job and journals their removal once the stream is inactive. Linux requests fail closed until its sandbox policy is implemented. Cancellation and timeout tear down every process the kb-runner supervisor can attribute and report unresolved identities; a same-UID macOS descendant that closes inherited fd 3, clears `KBLABS_CLIPROC_RUN`, and detaches before its first snapshot is outside this guarantee ([supervisor ownership guarantee and platform limits](internal/proc/doc.go), also described in S-237.7). Disable the channel for a job with `--test-channel=off`; the orchestrator can also create `<state>/test-channel-off` to disable it for all jobs using that state directory, then remove the file to re-enable it.

## Transient provider failures resume the same session

Agent jobs survive provider hiccups. Each vendor adapter owns a failure table that classifies every provider failure from the structured fields the vendor emits — ZCode's `turn.failed` attribution (provider codes such as 3009, HTTP statuses, network transport markers) or the vendor's failure kinds — into transient (network loss, concurrency and rate limits, 5xx) and permanent (authentication, quota exhaustion, invalid request) classes.

A transient failure pauses the job, waits out an increasing backoff (for vendors that publish limit windows, the wait follows the vendor's reset time), and resumes the same session with a fixed continuation prompt written to `<state>/jobs/<job>.continue.md`. Up to three resumes are attempted per job, and every attempt is recorded in the job's `Attempts` with its number, session, outcome, reason, and spend accounting. Permanent failures, unclassifiable failures, and exhausted attempts end the job with the catalogued reason, the diagnostic, and the exact manual resume command. A failed turn never reports spend as zero: when the vendor does not expose usage for a failed turn, the attempt is recorded as usage unknown and `limits` marks the ledger total incomplete.
