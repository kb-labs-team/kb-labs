# Agent Tracing System

## Overview

KB Labs Agents include a comprehensive incremental tracing system for debugging and analyzing agent execution. The system writes detailed events in real-time to NDJSON files, providing full visibility into agent behavior, LLM calls, tool usage, errors, and performance metrics.

## Key Features

- ✅ **Incremental NDJSON format** - Append-only, crash-safe trace files
- ✅ **Real-time writing** - Dual flush: 100ms OR 10 events (whichever comes first)
- ✅ **12 detailed event types** - Complete execution visibility
- ✅ **Privacy redaction** - Automatic secret and path sanitization
- ✅ **AI-friendly CLI** - Commands with `--json` output for programmatic analysis
- ✅ **Cost tracking** - Automatic token usage and cost calculation
- ✅ **Performance metrics** - Duration tracking at event and iteration level

## Architecture

### Components

1. **IncrementalTraceWriter** (`@kb-labs/agents/core`)
   - Real-time NDJSON writing with dual flush mechanism
   - Privacy redaction with shallow clone optimization
   - Automatic index generation for fast lookups

2. **Trace CLI Commands** (`@kb-labs/agents/cli`)
   - `agent:trace:stats` - Statistics with cost analysis
   - `agent:trace:filter` - Filter events by type
   - `agent:trace:iteration` - View specific iteration details

3. **Privacy Redactor** (`@kb-labs/agents/core`)
   - Pattern-based secret detection (API keys, tokens, passwords)
   - Path replacement for privacy compliance
   - Shallow clone optimization (only clones if secrets found)

## Trace Event Types

### Core Events

| Event Type | Description | Key Fields |
|------------|-------------|------------|
| `iteration:detail` | Iteration metadata | iteration, reason, availableTools, config |
| `llm:call` | LLM request/response | request, response, cost, timing |
| `tool:execution` | Tool call execution | tool, input, output, timing |
| `memory:snapshot` | Memory state snapshot | facts, findings, filesRead, toolsUsed |

### Analysis Events

| Event Type | Description | Key Fields |
|------------|-------------|------------|
| `decision:point` | Decision-making checkpoint | decision, reasoning, alternatives |
| `synthesis:forced` | Forced synthesis trigger | reason, synthesisCount |
| `error:captured` | Error capture | error, context, recoveryAttempted |
| `prompt:diff` | Prompt changes | added, removed, totalSize |

### Optimization Events

| Event Type | Description | Key Fields |
|------------|-------------|------------|
| `tool:filter` | Tool filtering applied | before, after, reason |
| `context:trim` | Context trimming | before, after, method |
| `stopping:analysis` | Stop condition check | shouldStop, reason, confidence |
| `llm:validation` | LLM output validation | valid, issues, fixApplied |

## Usage

### 1. Enable Tracing (Enabled by Default)

Tracing is automatically enabled when running agents:

```typescript
import { AgentExecutor } from '@kb-labs/agents/core';

const executor = new AgentExecutor({
  agentId: 'my-agent',
  taskId: 'task-2026-01-29-abc123',
  // Tracing is enabled by default
});

await executor.execute(task, tools);
// Trace written to: .kb/traces/incremental/task-2026-01-29-abc123.ndjson
```

### 2. Configure Privacy Redaction

```typescript
const executor = new AgentExecutor({
  agentId: 'my-agent',
  taskId: 'task-abc',
  traceConfig: {
    privacy: {
      redactSecrets: true,  // Default: true
      redactPaths: true,    // Default: true
      secretPatterns: [
        'custom-api-key-\\w+',
      ],
      pathReplacements: {
        '/Users/john/projects': '/home/user/projects',
      },
    },
  },
});
```

### 3. View Trace Statistics

```bash
# Human-readable output
pnpm kb agent:trace:stats --task-id=task-2026-01-29-abc123

# JSON output (for AI agents)
pnpm kb agent:trace:stats --task-id=task-2026-01-29-abc123 --json
```

**Example output:**

```
📊 Trace Statistics

Status: ✅ Success
Iterations: 5

🤖 LLM Usage:
  Calls: 8
  Input tokens: 12,458
  Output tokens: 3,241
  Total tokens: 15,699

🔧 Tool Usage:
  Total calls: 15
  Successful: 14
  Failed: 1
  By tool:
    fs:read: 8
    mind:rag-query: 4
    fs:write: 3

⏱️  Timing:
  Started: 2026-01-29T10:15:30.000Z
  Completed: 2026-01-29T10:18:45.000Z
  Duration: 3m 15s

💰 Cost:
  Total: $0.0589 USD
```

### 4. Filter Events by Type

```bash
# View all LLM calls
pnpm kb agent:trace:filter --task-id=task-abc --type=llm:call

# View tool executions (JSON for agents)
pnpm kb agent:trace:filter --task-id=task-abc --type=tool:execution --json

# View errors
pnpm kb agent:trace:filter --task-id=task-abc --type=error:captured
```

**Example output:**

```
🔍 Filtered Events: llm:call
Found 8 events

Showing first 8/8:

[15] 2026-01-29T10:15:35.123Z (iteration 1)
  Model: claude-sonnet-4-5, Tokens: 2341, Cost: $0.012345

[28] 2026-01-29T10:16:12.456Z (iteration 2)
  Model: claude-sonnet-4-5, Tokens: 1823, Cost: $0.009876

...
```

### 5. View Iteration Details

```bash
# View iteration 3
pnpm kb agent:trace:iteration --task-id=task-abc --iteration=3

# JSON output
pnpm kb agent:trace:iteration --task-id=task-abc --iteration=3 --json
```

**Example output:**

```
🔄 Iteration 3

📊 Summary:
  Total events: 12
  LLM calls: 2
  Tool calls: 5
  Errors: 0
  Duration: 45382ms

📝 Events Timeline:

  iteration:detail: 1
  llm:call: 2
    Model: claude-sonnet-4-5
    Tokens: 3241
    Cost: $0.014523
  tool:execution: 5
    Tools: fs:read, mind:rag-query, fs:write
  memory:snapshot: 1
  decision:point: 2
  stopping:analysis: 1

Use --json flag to see full event details
```

## Trace File Format

### NDJSON Structure

Trace files use Newline Delimited JSON (NDJSON) format:

```
{"type":"iteration:detail","seq":1,"timestamp":"2026-01-29T10:15:30.000Z",...}
{"type":"llm:call","seq":2,"timestamp":"2026-01-29T10:15:32.123Z",...}
{"type":"tool:execution","seq":3,"timestamp":"2026-01-29T10:15:35.456Z",...}
```

### Location

- **Trace files**: `.kb/traces/incremental/{taskId}.ndjson`
- **Index files**: `.kb/traces/incremental/{taskId}.index.json`

### Index Structure

```json
{
  "taskId": "task-2026-01-29-abc123",
  "totalEvents": 127,
  "eventTypes": {
    "iteration:detail": 5,
    "llm:call": 8,
    "tool:execution": 15,
    "memory:snapshot": 5,
    "decision:point": 12,
    "synthesis:forced": 2,
    "error:captured": 1,
    "prompt:diff": 8,
    "tool:filter": 4,
    "context:trim": 3,
    "stopping:analysis": 5,
    "llm:validation": 8
  },
  "firstTimestamp": "2026-01-29T10:15:30.000Z",
  "lastTimestamp": "2026-01-29T10:18:45.000Z"
}
```

## Privacy & Security

### Automatic Secret Redaction

Default patterns detected and redacted:

- API keys: `sk-[a-zA-Z0-9]+`, `pk_[a-zA-Z0-9]+`
- Tokens: `[a-f0-9]{32,}` (32+ hex chars)
- Passwords: `"password":\s*"[^"]+"`
- Bearer tokens: `Bearer\s+[A-Za-z0-9\-._~+/]+=*`
- AWS keys: `AKIA[0-9A-Z]{16}`

### Custom Patterns

Add your own patterns:

```typescript
traceConfig: {
  privacy: {
    secretPatterns: [
      'MY_CUSTOM_SECRET_\\w+',
      'internal-token-[a-z0-9]+',
    ],
  },
}
```

### Path Replacement

Replace sensitive paths:

```typescript
traceConfig: {
  privacy: {
    pathReplacements: {
      '/Users/john/company-secrets': '/home/user/redacted',
      'C:\\Users\\jane\\Documents': 'C:\\Users\\redacted',
    },
  },
}
```

## Performance

### Dual Flush Mechanism

The tracer uses a dual flush strategy for optimal balance between real-time writing and performance:

- **Time-based**: Flush every 100ms
- **Event-based**: Flush when buffer reaches 10 events
- **Whichever comes first** ensures low latency without excessive I/O

### Shallow Clone Optimization

Privacy redaction only clones objects if secrets are detected:

```typescript
// Fast path (no secrets found)
if (!needsRedaction) {
  return event;  // Return original, no clone!
}

// Slow path (secrets found)
return redactValue(event, config, 0);  // Deep clone and redact
```

**Performance impact:**
- No secrets: ~0.1ms per event (no clone)
- With secrets: ~1-2ms per event (clone + redact)

## AI-Friendly JSON Output

All trace commands support `--json` flag for programmatic consumption:

```json
{
  "success": true,
  "command": "trace:stats",
  "taskId": "task-abc",
  "data": {
    "iterations": { "total": 5, "completed": 5 },
    "llm": { "calls": 8, "inputTokens": 12458, "outputTokens": 3241, "totalTokens": 15699 },
    "tools": { "totalCalls": 15, "byTool": {...}, "successful": 14, "failed": 1 },
    "timing": { "startedAt": "...", "completedAt": "...", "totalDurationMs": 195000, "durationFormatted": "3m 15s" },
    "cost": { "total": 0.0589, "currency": "USD" },
    "errors": 0
  },
  "summary": {
    "message": "5 iterations, 8 LLM calls, $0.0589 cost",
    "severity": "info",
    "actionable": false
  }
}
```

## Cost Tracking

### Automatic Calculation

LLM costs are automatically calculated in `llm:call` events:

```json
{
  "type": "llm:call",
  "cost": {
    "inputCost": 0.007374,
    "outputCost": 0.048615,
    "totalCost": 0.055989,
    "currency": "USD",
    "model": "claude-sonnet-4-5"
  }
}
```

**Pricing (as of 2026-01-29):**
- Input: $3.00 per 1M tokens
- Output: $15.00 per 1M tokens

### Aggregate Costs

Use `trace:stats` to see total cost across all iterations:

```bash
pnpm kb agent:trace:stats --task-id=task-abc --json | jq '.data.cost'
```

## Error Handling

### Error Capture

All errors are captured in `error:captured` events:

```json
{
  "type": "error:captured",
  "seq": 42,
  "timestamp": "2026-01-29T10:17:23.456Z",
  "iteration": 3,
  "error": {
    "name": "ToolExecutionError",
    "message": "Failed to read file: ENOENT",
    "stack": "..."
  },
  "context": {
    "toolName": "fs:read",
    "input": { "path": "/missing/file.txt" }
  },
  "recoveryAttempted": true
}
```

### View All Errors

```bash
pnpm kb agent:trace:filter --task-id=task-abc --type=error:captured
```

## Best Practices

### DO ✅

- **Always use `--json` for programmatic access** - Structured output for agents
- **Check trace files after agent failures** - Full execution history preserved
- **Use `trace:stats` for quick overview** - Cost, performance, errors at a glance
- **Enable privacy redaction in production** - Prevent secret leakage
- **Archive old trace files** - Keep `.kb/traces/incremental/` clean

### DON'T ❌

- **Don't disable tracing in production** - Critical for debugging
- **Don't commit trace files to git** - Large files, may contain secrets
- **Don't parse NDJSON manually** - Use trace CLI commands
- **Don't modify trace files** - Append-only format, corruption risk

## Troubleshooting

### Trace file not found

```bash
ls -la .kb/traces/incremental/
# Verify task ID matches filename
```

### Empty trace file

```bash
# Check if agent actually ran
pnpm kb agent:trace:stats --task-id=task-abc --json
# → "CORRUPTED_TRACE: Trace file is empty"
```

### Invalid event type

```bash
# List valid event types
pnpm kb agent:trace:filter --task-id=task-abc --type=invalid
# → Shows all 12 valid event types
```

## API Reference

### IncrementalTraceWriter

```typescript
import { IncrementalTraceWriter } from '@kb-labs/agents/core';

const writer = new IncrementalTraceWriter(taskId, {
  privacy: {
    redactSecrets: true,
    redactPaths: true,
    secretPatterns: ['custom-pattern'],
    pathReplacements: { '/old/path': '/new/path' },
  },
  flushIntervalMs: 100,
  flushThreshold: 10,
});

// Write event
await writer.write({
  type: 'llm:call',
  request: {...},
  response: {...},
  cost: {...},
  timing: {...},
});

// Finalize trace
await writer.finalize();
```

### CLI Commands

```bash
# Stats
pnpm kb agent:trace:stats --task-id=<id> [--json]

# Filter
pnpm kb agent:trace:filter --task-id=<id> --type=<type> [--json]

# Iteration
pnpm kb agent:trace:iteration --task-id=<id> --iteration=<N> [--json]
```

## Future Enhancements

**Planned for Phase 9+:**

- [ ] `trace:analyze` - Pattern detection (retry loops, context loss, etc.)
- [ ] `trace:compare` - Compare two traces side-by-side
- [ ] `trace:snapshot` - View memory state at specific iteration
- [ ] `trace:export` - Export to JSON/Markdown/HTML
- [ ] `trace:replay` - Programmatic replay for testing
- [ ] Web UI for trace visualization
- [ ] Real-time trace streaming via WebSocket

---

**Version:** 1.0.0
**Last Updated:** 2026-01-29
**Status:** ✅ Production Ready
