# VS Code Debugging Setup

## Overview

This guide explains how to set up VS Code for debugging KB Labs plugins with breakpoints, step-through debugging, and integrated testing.

## Quick Setup

1. **Copy configuration files**:
   ```bash
   cp .vscode/launch.json.example .vscode/launch.json
   cp .vscode/tasks.json.example .vscode/tasks.json
   ```

2. **Install recommended extensions** (optional):
   - TypeScript and JavaScript Language Features (built-in)
   - ESLint (optional, for linting)

3. **Start debugging**:
   - Press `F5` or go to Run and Debug view
   - Select "Debug Plugin Command (Inspect)"
   - Enter your command when prompted

## Launch Configurations

### Debug Plugin Command (Inspect)

Launches a plugin command with `--debug=inspect` flag, allowing you to attach a debugger.

**Usage**:
1. Press `F5`
2. Enter command (e.g., `mind:init` or `mind:query --query test`)
3. Process will start paused at first line
4. VS Code will automatically attach debugger

**Configuration**:
```json
{
  "name": "Debug Plugin Command (Inspect)",
  "type": "node",
  "request": "launch",
  "runtimeExecutable": "pnpm",
  "runtimeArgs": [
    "exec",
    "kb",
    "--debug=inspect",
    "${input:command}"
  ],
  "console": "integratedTerminal",
  "internalConsoleOptions": "neverOpen",
  "skipFiles": ["<node_internals>/**"],
  "sourceMaps": true
}
```

### Debug Plugin Command (Attach)

Attaches to an already running process that was launched with `--debug=inspect`.

**Usage**:
1. Launch command in terminal with `--debug=inspect`:
   ```bash
   pnpm exec kb mind:init --debug=inspect
   ```
2. Note the port number (e.g., `9229`)
3. Press `F5` and select "Debug Plugin Command (Attach)"
4. Debugger will attach to running process

**Configuration**:
```json
{
  "name": "Debug Plugin Command (Attach)",
  "type": "node",
  "request": "attach",
  "port": 9229,
  "restart": false,
  "localRoot": "${workspaceFolder}",
  "remoteRoot": "${workspaceFolder}",
  "protocol": "inspector",
  "skipFiles": ["<node_internals>/**"],
  "sourceMaps": true
}
```

### Replay Snapshot

Replays a saved snapshot for debugging.

**Usage**:
1. Press `F5`
2. Select "Replay Snapshot"
3. Enter snapshot ID (e.g., `2025-01-15-123456-mind-init`)
4. Debugger will attach to replay process

### Debug Test

Debug plugin tests with breakpoints.

**Usage**:
1. Press `F5`
2. Select "Debug Test"
3. Set breakpoints in test files
4. Tests will run with debugger attached

## Tasks

### Build Plugin

Builds a specific plugin package.

**Usage**:
1. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac)
2. Type "Tasks: Run Task"
3. Select "Build Plugin"
4. Enter plugin package name (e.g., `@kb-labs/mind/cli`)

### Run Dev Mode

Runs a command in watch mode with hot reload.

**Usage**:
1. Run task "Run Dev Mode"
2. Enter command (e.g., `mind:init`)
3. Command will restart automatically on file changes

### Run Tests

Runs plugin tests.

**Usage**:
1. Run task "Run Tests"
2. Enter plugin package name
3. Tests will run in terminal

### Watch Plugin

Watches plugin source files and rebuilds automatically.

**Usage**:
1. Run task "Watch Plugin"
2. Enter plugin package name
3. Plugin will rebuild on file changes

## Breakpoints

### Setting Breakpoints

1. Open your handler file (e.g., `src/cli/init.ts`)
2. Click in the gutter next to line numbers
3. Red dot indicates breakpoint
4. Start debugging with `F5`

### Conditional Breakpoints

1. Right-click on breakpoint
2. Select "Edit Breakpoint"
3. Enter condition (e.g., `input.force === true`)
4. Breakpoint will only trigger when condition is true

### Logpoints

1. Right-click on line
2. Select "Add Logpoint"
3. Enter expression (e.g., `input: ${JSON.stringify(input)}`)
4. Expression will be logged without stopping execution

## Debugging Tips

### Source Maps

Make sure source maps are enabled in your `tsup.config.ts`:

```typescript
export default defineConfig({
  // ... other config
  sourcemap: true,
  // ...
})
```

### TypeScript Support

VS Code should automatically detect TypeScript files. If not:

1. Check that `tsconfig.json` exists in workspace root
2. Ensure TypeScript extension is enabled
3. Reload VS Code window (`Ctrl+Shift+P` → "Reload Window")

### Debugging Sandbox Code

Sandbox code runs in a separate process. To debug:

1. Use `--debug=inspect` flag
2. VS Code will automatically attach to subprocess
3. Set breakpoints in handler files (not sandbox bootstrap)

### Debugging Cross-Plugin Calls

When debugging cross-plugin invocations:

1. Use `kb trace` to see call flow
2. Set breakpoints in both caller and callee plugins
3. Use "Step Into" (`F11`) to step into cross-plugin calls

## Common Issues

### Issue: Breakpoints not hit

**Solutions**:
- Check source maps are enabled
- Verify file paths match between source and compiled code
- Try "Reload Window" in VS Code
- Check that you're using `--debug=inspect` flag

### Issue: Can't step into dependencies

**Solutions**:
- Add `skipFiles` to launch configuration to skip node internals
- Use "Step Into" (`F11`) instead of "Step Over" (`F10`)
- Check that source maps exist for dependencies

### Issue: Port already in use

**Solutions**:
- Kill existing process using port 9229
- Change port in launch configuration
- Use `--debug=inspect` with custom port (not yet supported, will use default)

## Snippets

VS Code snippets are available in `.vscode/snippets/kb-plugin.json`.

### Available Snippets

- **`kb-handler`**: Plugin handler template
- **`kb-test`**: Plugin test template
- **`kb-manifest`**: Manifest V2 template

### Using Snippets

1. Type snippet prefix (e.g., `kb-handler`)
2. Press `Tab` to expand
3. Fill in placeholders
4. Press `Tab` to move to next placeholder

## Advanced Configuration

### Custom Port

Edit `.vscode/launch.json` to use custom port:

```json
{
  "configurations": [
    {
      "name": "Debug Plugin Command (Custom Port)",
      "type": "node",
      "request": "launch",
      "runtimeExecutable": "pnpm",
      "runtimeArgs": [
        "exec",
        "kb",
        "--debug=inspect",
        "${input:command}"
      ],
      "port": 9230,  // Custom port
      // ... rest of config
    }
  ]
}
```

### Environment Variables

Add environment variables to launch configuration:

```json
{
  "configurations": [
    {
      "name": "Debug with Env",
      "env": {
        "NODE_ENV": "development",
        "KB_PLUGIN_DEV_MODE": "true"
      },
      // ... rest of config
    }
  ]
}
```

## Additional Resources

- [Debugging Guide](./debugging.md)
- [Performance Profiling](./performance.md)
- [VS Code Debugging Documentation](https://code.visualstudio.com/docs/nodejs/nodejs-debugging)






