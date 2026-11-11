# Debug System for KB Labs Plugins

## Overview

KB Labs provides a powerful debugging system for plugin developers that enables quick bug detection and fixes, safe plugin testing, and performance optimization. The debug system features:

- **Structured logging** with trace IDs and span IDs for full execution tracing
- **Two output formats**: Human-first (visual tree) and AI-first (machine-readable JSON)
- **Contextual grouping** of logs by execution stage
- **Automatic trace correlation** across plugin boundaries
- **Performance metrics** with timing information

## Quick Start

### Basic Debugging

```bash
# Enable stream logs and auto-snapshot on errors
kb mind init --debug

# Maximum verbosity with structured output
kb mind query --query "meta" --debug=verbose

# Human-readable format (default)
kb mind query --query "meta" --debug

# Machine-readable JSON format (for AI analysis)
kb mind query --query "meta" --debug --json

# Node.js debugger (for breakpoints in IDE)
kb mind init --debug=inspect

# Performance profiling
kb mind pack --debug=profile
```

## Flags

### `--debug`

Basic debug mode with structured output:
- Stream logs in real-time with color formatting
- Structured logs with timestamps and namespaces
- Trace IDs and span IDs for correlation
- Automatically save snapshots on errors
- Show last 50 lines of logs on error

**Example**:
```bash
kb mind init --debug
```

**Output format** (Human-first):
```
[24:10:57.837] [DEBUG] [runtime:execute] Execute function called
  ├─ handler: ./cli/query#run
  ├─ pluginRoot: /path/to/plugin
  ├─ traceId: r-3ari5w6
  └─ spanId: r-1taypq6

[24:10:57.850] [DEBUG] [sandbox:inprocess] Starting handler execution
  ├─ traceId: r-3ari5w6
  └─ spanId: r-1taypq6
```

### `--debug=verbose`

Maximum verbosity with detailed information:
- All logs from sandbox
- Detailed information about each execution stage
- Extended metrics and timing
- Full context metadata

**Example**:
```bash
kb mind query --query "meta" --debug=verbose
```

### `--debug --json` (AI-first format)

Machine-readable JSON format for automated analysis:
- Perfect for AI tools and log analysis scripts
- Structured JSON with all metadata
- Easy to filter and search programmatically
- Can be exported and analyzed later

**Example**:
```bash
kb mind query --query "meta" --debug --json
```

**Output format** (AI-first):
```json
{"timestamp":"2024-01-15T24:10:57.837Z","namespace":"runtime:execute","level":"debug","message":"Execute function called","meta":{"handler":"./cli/query#run","pluginRoot":"/path/to/plugin"},"traceId":"r-3ari5w6","spanId":"r-1taypq6"}
{"timestamp":"2024-01-15T24:10:57.850Z","namespace":"sandbox:inprocess","level":"debug","message":"Starting handler execution","traceId":"r-3ari5w6","spanId":"r-1taypq6","parentSpanId":"r-1taypq6"}
```

**Usage for analysis**:
```bash
# Filter logs by traceId
kb mind query --query "meta" --debug --json | jq 'select(.traceId == "r-3ari5w6")'

# Find all errors
kb mind query --query "meta" --debug --json | jq 'select(.level == "error")'

# Build execution graph
kb mind query --query "meta" --debug --json | jq -r '.[] | "\(.spanId) -> \(.parentSpanId // "root")"' | sort -u
```

### `--debug=inspect`

Node.js debugger mode:
- Launches process with `--inspect-brk`
- Allows connecting VS Code or Chrome DevTools
- Automatically finds available port (starting from 9229)
- Pauses at first line of handler

**Example**:
```bash
kb mind init --debug=inspect
```

After launch you'll see:
```
🔍 Node.js Debugger Mode
   The process will pause at the first line of your handler
   Connect your debugger to continue

   Options:
   1. Chrome DevTools: Open chrome://inspect
   2. VS Code: Attach to process (F5)
   3. Command line: node inspect <script>
```

### `--debug=profile`

Performance profiling:
- Collects detailed execution metrics
- Shows ASCII timeline visualization
- Export to Chrome DevTools format

**Example**:
```bash
kb mind pack --debug=profile
```

With export option:
```bash
kb mind pack --debug=profile --profile-export=./profile.json
```

### `--dry-run`

Safe testing without side effects:
- Logs operations instead of executing them
- Shows what would be done
- Summary at the end

**Example**:
```bash
kb mind init --dry-run
```

Output:
```
[DRY-RUN] Would write to: ./mind.json (123 bytes)
[DRY-RUN] Would POST to: https://api.example.com
Would perform: 5 writes, 2 network requests
```

## Commands

### `kb replay`

Replay snapshot to reproduce bugs:

```bash
# List all snapshots
kb replay --list

# Replay last snapshot
kb replay --last

# Replay specific snapshot
kb replay <snapshot-id>

# Replay with debug mode
kb replay <snapshot-id> --debug

# Replay in dry-run mode
kb replay <snapshot-id> --dry-run
```

**Example**:
```bash
$ kb mind init --force
✗ Error: Permission denied
📸 Snapshot saved: .kb/debug/tmp/snapshots/2025-01-15-123456-mind-init.json
   Replay with: kb replay 2025-01-15-123456-mind-init

$ kb replay 2025-01-15-123456-mind-init
Replaying snapshot: 2025-01-15-123456-mind-init
Command: mind init
Timestamp: 2025-01-15T12:34:56.789Z
Plugin: @kb-labs/mind/cli@0.1.0
```

### `kb trace`

Visualize cross-plugin traces:

```bash
# List all traces
kb trace --list

# Last trace
kb trace --last

# Specific trace
kb trace <trace-id>
```

**Example output**:
```
Trace: abc-123-def (total: 450ms)

mind query (250ms)
├─ shared:search (150ms)
│  └─ core:index (100ms)
│     └─ fs:read (10ms)
└─ mind:format (50ms)

Spans: 4 | Plugins: 3 | Errors: 0
Details: .kb/debug/tmp/traces/abc-123-def.json
```

### `kb repl`

Interactive REPL for quick testing:

```bash
kb repl mind query
```

**Usage example**:
```bash
$ kb repl mind query
kb-repl> run --query "test" --json
{...result 1...}
kb-repl> run --query "test2"
{...result 2...}
kb-repl> exit
```

### `kb dev`

Watch mode with hot reload:

```bash
kb dev mind query --query "test"
```

Automatically restarts command when code changes.

### `kb fix`

Quick fix for common errors:

```bash
# Fix last error
kb fix --last

# Fix specific error code
kb fix MODULE_NOT_FOUND
```

## Automatic Snapshots

On any error, a snapshot is automatically saved to `.kb/debug/tmp/snapshots/`.

Snapshots contain:
- Input and flags
- Execution context (workdir, env)
- Logs (last 50 lines)
- Error details (code, message, stack)
- Metrics (duration, memory, CPU)

**Example message**:
```
✗ Error: Permission denied
📸 Snapshot saved: .kb/debug/tmp/snapshots/2025-01-15-123456-mind-init.json
   Replay with: kb replay 2025-01-15-123456-mind-init
```

Snapshots are automatically rotated (keep last 30).

## Error Suggestions

When an error occurs, smart suggestions are automatically shown:

**Example**:
```
✗ Error: MODULE_NOT_FOUND

💡 Suggestions:
  1. Check handler path in manifest and ensure the file exists.
     Fix: Verify `handler` path in `manifest.v2.ts` (e.g., `./cli/init#run`) and ensure the corresponding `.js` file is built in `dist/`.
     Docs: https://kb.labs/docs/plugins/troubleshooting#module-not-found
  
  2. Rebuild the plugin to ensure all files are compiled.
     Fix: Run `pnpm --filter @kb-labs/<plugin-name> build` in your monorepo root.
```

## VS Code Integration

### Setup

1. Copy `.vscode/launch.json.example` to `.vscode/launch.json`
2. Copy `.vscode/tasks.json.example` to `.vscode/tasks.json`
3. Configure snippets (optional)

### Debugging

1. **Debug Plugin Command (Inspect)**:
   - Press F5
   - Enter command (e.g., `mind init`)
   - Process will launch with `--debug=inspect`
   - Attach debugger (VS Code or Chrome DevTools)

2. **Debug Plugin Command (Attach)**:
   - Launch command with `--debug=inspect` in terminal
   - Press F5 and select "Debug Plugin Command (Attach)"
   - Debugger will attach to running process

3. **Replay Snapshot**:
   - Press F5
   - Select "Replay Snapshot"
   - Enter snapshot ID
   - Debugger will attach to replay process

### Tasks

- **Build Plugin**: Build specific plugin
- **Run Dev Mode**: Run in watch mode
- **Run Tests**: Run tests
- **Watch Plugin**: Watch mode for automatic rebuild

## Debug System Features

### Structured Logging

All debug logs are structured with:
- **Timestamp**: Precise time for each log entry
- **Namespace**: Component name (e.g., `runtime:execute`, `sandbox:inprocess`)
- **Level**: `debug`, `info`, `warn`, or `error`
- **Message**: Human-readable message
- **Metadata**: Additional context (handler, pluginRoot, etc.)
- **Trace ID**: Unique identifier for entire command execution
- **Span ID**: Unique identifier for current execution span
- **Parent Span ID**: Links spans in execution hierarchy

### Trace Correlation

With `traceId` and `spanId`, you can:
- **Track entire execution flow**: All logs with same `traceId` belong to one command
- **Build execution graph**: Use `spanId` → `parentSpanId` to visualize call hierarchy
- **Filter by trace**: Find all logs related to a specific command execution
- **Debug cross-plugin calls**: Trace IDs propagate across plugin boundaries

**Example**:
```bash
# Find all logs for a specific trace
kb mind query --query "meta" --debug --json | jq 'select(.traceId == "r-3ari5w6")'
```

### Contextual Grouping

Logs are automatically grouped by execution context:
```
execute
  ├─ Execute function called
  ├─ sandbox
  │   ├─ Creating sandbox runner
  │   └─ runner.run
  │       ├─ Calling runner.run
  │       └─ runner.run completed
  └─ Checking result after execution
```

This makes it easy to:
- Understand execution flow
- Find where errors occurred
- See timing relationships

### Performance Analysis

Debug logs include timing information:
- **Timestamps** for each log entry
- **Duration** measurements for operations
- **Performance metrics** in verbose mode

**Example**:
```
[24:10:57.837] Execute function called
[24:10:57.850] Starting handler execution (13ms)
[24:10:58.189] ERROR (339ms delay - slow operation!)
```

## Best Practices

1. **Use `--debug` regularly** to understand what's happening
2. **Use `--debug --json`** for automated log analysis
3. **Use trace IDs** to correlate logs across components
4. **Save snapshots** on errors for reproduction
5. **Use `--dry-run`** before real operations
6. **Use `kb dev`** for fast iteration during development
7. **Use `--debug=profile`** for performance optimization
8. **Use `kb trace`** to understand cross-plugin interactions
9. **Export logs** for analysis when debugging complex issues

## Analyzing Debug Logs

### Filtering by Trace ID

When debugging a specific command execution:

```bash
# Get trace ID from error message
# Then filter all logs for that trace
kb mind query --query "meta" --debug --json | jq 'select(.traceId == "r-3ari5w6")'
```

### Finding Errors

```bash
# Find all errors in logs
kb mind query --query "meta" --debug --json | jq 'select(.level == "error")'

# Find errors with full context
kb mind query --query "meta" --debug --json | jq 'select(.level == "error") | {timestamp, namespace, message, meta, traceId, spanId}'
```

### Building Execution Graph

```bash
# Build span hierarchy
kb mind query --query "meta" --debug --json | jq -r 'select(.spanId) | "\(.spanId) -> \(.parentSpanId // "root")"' | sort -u

# Visualize execution flow
kb mind query --query "meta" --debug --json | jq -r 'select(.group) | "\(.group) [\(.namespace)]"' | sort -u
```

### Performance Analysis

```bash
# Find slow operations
kb mind query --query "meta" --debug --json | jq 'select(.duration > 1000) | {message, duration, namespace}'

# Analyze timing
kb mind query --query "meta" --debug --json | jq '[.[] | select(.timestamp) | .timestamp] | (max - min)'
```

## Troubleshooting

### Issue: Logs not showing

**Solution**: Make sure you're using the `--debug` flag

### Issue: Can't find trace ID in logs

**Solution**: 
1. Use `--debug --json` to get structured output
2. Look for `traceId` field in JSON logs
3. Use `jq` to filter: `jq 'select(.traceId == "your-trace-id")'`

### Issue: Debugger not attaching

**Solution**: 
1. Check that port is available (default 9229)
2. Make sure you're using `--debug=inspect`
3. Check source maps in `tsup.config.ts`

### Issue: Snapshot not created

**Solution**: 
1. Check write permissions for `.kb/debug/tmp/snapshots/`
2. Make sure error occurred (snapshots are only created on errors)

### Issue: Trace not saved

**Solution**: 
1. Traces are only created on cross-plugin invocations
2. Check that `invoke` is used in plugin
3. Make sure registry is available

## Debug System Architecture

The debug system is built on top of `@kb-labs/shared-cli-ui/debug` and provides:

- **Two formatters**: AI-first (JSON) and Human-first (visual tree)
- **Structured types**: Type-safe debug entries with full TypeScript support
- **Filtering utilities**: Filter by namespace, level, time range, or search text
- **Export capabilities**: Export to JSON, Chrome DevTools format, or plain text
- **Visualization**: Tree and timeline views for trace visualization

For detailed API documentation, see:
- [Debug System API](../../../kb-labs-shared/packages/cli-ui/src/debug/README.md)

## Additional Resources

- [Debug System API](../../../kb-labs-shared/packages/cli-ui/src/debug/README.md) - Detailed API documentation
- [Performance Profiling](./performance.md)
- [VS Code Debugging](./vscode-debugging.md)
- [Analytics Integration](./analytics.md)
- [Debug System Comparison](../../../DEBUG_SYSTEM_COMPARISON.md) - Comparison of old vs new system
