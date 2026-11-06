# KB Labs Workflow Commands

This document describes the workflow commands available in KB Labs CLI.

## Overview

KB Labs Workflow provides a powerful workflow engine for automating tasks, similar to GitHub Actions but with enhanced features:

- **Nested Workflows**: Call workflows from within workflows
- **Conditional Execution**: Use `if` expressions to control step/job execution
- **Step Outputs**: Capture and reuse outputs between steps
- **Job Hooks**: Pre/post/onSuccess/onFailure lifecycle hooks
- **Live Logs**: Real-time log streaming via Redis pub/sub
- **Approval Steps**: Manual approval gates in workflows
- **Artifact Merge**: Merge artifacts from multiple workflow runs
- **Local Replay**: Replay workflows from snapshots
- **Remote Marketplace**: Use workflows from git repositories
- **Budget Control**: Track and limit workflow execution costs

## Commands

### `kb wf list`

List all discovered workflows from workspace and plugins.

**Usage:**
```bash
kb wf list [--source=<source>] [--tag=<tag>] [--json]
```

**Options:**
- `--source=<source>`: Filter by source (`workspace`, `plugin`, or `all`). Default: `all`
- `--tag=<tag>`: Filter by tag
- `--json`: Output as JSON

**Examples:**
```bash
# List all workflows
kb wf list

# List only workspace workflows
kb wf list --source=workspace

# List workflows with specific tag
kb wf list --tag=ai

# JSON output
kb wf list --json
```

**Output:**
```
📋 Available Workflows

📁 WORKSPACE
  • workspace:ai-ci - AI-powered CI workflow
  • workspace:deploy - Deployment workflow

🔌 PLUGIN
  • plugin:@kb-labs/ai-review/full-audit - Complete AI code review and audit [review, audit, quality]
  • plugin:@kb-labs/release/standard-release - Standard release workflow [release, versioning]
```

### `kb wf init`

Initialize a new workflow file with a template.

**Usage:**
```bash
kb wf init --id=<id> --template=<template> [--dir=<dir>]
```

**Options:**
- `--id=<id>`: Workflow ID (filename without extension). Required.
- `--template=<template>`: Template to use. Required. Choices: `ai-ci-standard`, `nested-workflow`, `empty`
- `--dir=<dir>`: Output directory. Default: `.kb/workflows`

**Examples:**
```bash
# Create a new workflow from template
kb wf init --id=my-workflow --template=empty

# Create AI CI workflow
kb wf init --id=ai-ci --template=ai-ci-standard

# Create nested workflow example
kb wf init --id=nested --template=nested-workflow
```

**Templates:**
- `ai-ci-standard`: AI-powered CI workflow with Mind verify and AI review
- `nested-workflow`: Example of nested workflows with conditional execution
- `empty`: Basic workflow template with a single step

### `kb wf run`

Execute a workflow specification.

**Usage:**
```bash
kb wf run [--workflow-id=<id>] [--file=<file>] [--inline=<spec>] [--stdin] [--idempotency=<key>] [--concurrency-group=<group>] [--json] [--verbose]
```

**Options:**
- `--workflow-id=<id>`: Workflow ID from registry (e.g. `workspace:ai-ci`)
- `--file=<file>`: Path to workflow specification file
- `--inline=<spec>`: Inline workflow specification (JSON or YAML)
- `--stdin`: Read workflow spec from STDIN
- `--idempotency=<key>`: Idempotency key for the workflow run
- `--concurrency-group=<group>`: Concurrency group identifier
- `--json`: Output run details as JSON
- `--verbose`: Enable verbose logging

**Examples:**
```bash
# Run workflow from registry
kb wf run --workflow-id=workspace:ai-ci

# Run workflow from file
kb wf run --file=./kb.workflow.yml

# Run inline workflow
kb wf run --inline='{"name":"demo","on":{"manual":true},"jobs":{}}'

# Run from STDIN
cat kb.workflow.yml | kb wf run --stdin

# Run with idempotency key
kb wf run --workflow-id=workspace:deploy --idempotency=deploy-123
```

**Priority:**
1. `--workflow-id` (highest)
2. `--file`
3. `--inline`
4. `--stdin`
5. Default file (`kb.workflow.yml`)

### `kb wf logs`

Stream workflow run events and logs.

**Usage:**
```bash
kb wf logs <runId> [--follow] [--json] [--verbose]
```

**Options:**
- `--follow`: Continue streaming logs until interrupted
- `--json`: Output events as JSON (disabled with `--follow`)
- `--verbose`: Enable verbose logging

**Examples:**
```bash
# View logs for a run
kb wf logs 01HFYQ7C9X1Y2Z3A4B5C6D7E8F

# Follow logs in real-time
kb wf logs 01HFYQ7C9X1Y2Z3A4B5C6D7E8F --follow

# JSON output
kb wf logs 01HFYQ7C9X1Y2Z3A4B5C6D7E8F --json
```

**Note:** `--follow` uses Redis pub/sub for real-time log streaming. Make sure Redis is configured and running.

### `kb wf approve`

Approve or reject a pending approval step in a workflow.

**Usage:**
```bash
kb wf approve <runId> <stepId> [--reject] [--actor=<actor>] [--json] [--verbose]
```

**Options:**
- `--reject`: Reject the approval request instead of approving
- `--actor=<actor>`: Actor performing the approval/rejection. Default: `cli-user`
- `--json`: Output details as JSON
- `--verbose`: Enable verbose logging

**Examples:**
```bash
# Approve a step
kb wf approve 01HFYQ7C9X1Y2Z3A4B5C6D7E8F step-123

# Reject a step
kb wf approve 01HFYQ7C9X1Y2Z3A4B5C6D7E8F step-123 --reject

# Approve with custom actor
kb wf approve 01HFYQ7C9X1Y2Z3A4B5C6D7E8F step-123 --actor="john.doe@example.com"
```

### `kb wf replay`

Replay a workflow run from a snapshot.

**Usage:**
```bash
kb wf replay <runId> [--from-step=<stepId>] [--json] [--verbose]
```

**Options:**
- `--from-step=<stepId>`: Start replay from a specific step ID
- `--json`: Output as JSON
- `--verbose`: Enable verbose logging

**Examples:**
```bash
# Replay entire workflow
kb wf replay 01HFYQ7C9X1Y2Z3A4B5C6D7E8F

# Replay from specific step
kb wf replay 01HFYQ7C9X1Y2Z3A4B5C6D7E8F --from-step=step-123
```

**Note:** Requires a snapshot to be created first. Snapshots are automatically created for completed runs.

### `kb wf marketplace:add`

Add a remote marketplace source for workflows.

**Usage:**
```bash
kb wf marketplace:add --name=<name> --url=<url> [--ref=<ref>] [--path=<path>] [--json] [--verbose]
```

**Options:**
- `--name=<name>`: Marketplace name (required)
- `--url=<url>`: Git repository URL (required)
- `--ref=<ref>`: Branch or tag. Default: `main`
- `--path=<path>`: Subdirectory path in repository
- `--json`: Output as JSON
- `--verbose`: Enable verbose logging

**Examples:**
```bash
# Add marketplace
kb wf marketplace:add --name=kb-labs-official --url=https://github.com/kb-labs/workflows

# Add with specific branch
kb wf marketplace:add --name=my-workflows --url=https://github.com/user/repo --ref=v1.0.0
```

### `kb wf marketplace:list`

List configured remote marketplace sources.

**Usage:**
```bash
kb wf marketplace:list [--json]
```

**Examples:**
```bash
# List all marketplaces
kb wf marketplace:list

# JSON output
kb wf marketplace:list --json
```

### `kb wf marketplace:remove`

Remove a remote marketplace source.

**Usage:**
```bash
kb wf marketplace:remove --name=<name> [--json]
```

**Examples:**
```bash
kb wf marketplace:remove --name=kb-labs-official
```

### `kb wf marketplace:update`

Update remote marketplace sources (refetch from git).

**Usage:**
```bash
kb wf marketplace:update [--name=<name>] [--json] [--verbose]
```

**Options:**
- `--name=<name>`: Marketplace name to update (all if not specified)
- `--json`: Output as JSON
- `--verbose`: Enable verbose logging

**Examples:**
```bash
# Update all marketplaces
kb wf marketplace:update

# Update specific marketplace
kb wf marketplace:update --name=kb-labs-official
```

### `kb wf budget:status`

Show budget status for a workflow run.

**Usage:**
```bash
kb wf budget:status --runId=<runId> [--json] [--verbose]
```

**Options:**
- `--runId=<runId>`: Run ID to check budget for (required)
- `--json`: Output as JSON
- `--verbose`: Enable verbose logging

**Examples:**
```bash
# Check budget status
kb wf budget:status --runId=01HFYQ7C9X1Y2Z3A4B5C6D7E8F

# JSON output
kb wf budget:status --runId=01HFYQ7C9X1Y2Z3A4B5C6D7E8F --json
```

**Note:** Budget tracking must be enabled in `kb.config.json`.

## Workflow Specification

### Basic Structure

```yaml
name: my-workflow
version: 1.0.0
description: My workflow description
on:
  manual: true
jobs:
  my-job:
    runsOn: local
    steps:
      - name: My Step
        uses: builtin:shell
        with:
          command: echo "Hello World"
```

### Nested Workflows

```yaml
steps:
  - name: Call Child Workflow
    id: child
    uses: workflow:workspace:child-workflow
    with:
      input: value
  
  - name: Use Child Output
    uses: builtin:shell
    with:
      command: echo ${{ steps.child.outputs.result }}
```

### Conditional Execution

```yaml
jobs:
  deploy:
    if: ${{ trigger.type == 'push' && trigger.payload.ref == 'refs/heads/main' }}
    steps:
      - name: Deploy
        if: ${{ steps.tests.outputs.exitCode == 0 }}
        uses: builtin:shell
        with:
          command: npm run deploy
```

### Job Hooks

```yaml
jobs:
  main:
    runsOn: local
    hooks:
      pre:
        - name: Setup
          uses: builtin:shell
          with:
            command: echo "Setting up..."
      post:
        - name: Cleanup
          uses: builtin:shell
          with:
            command: echo "Cleaning up..."
      onSuccess:
        - name: Notify Success
          uses: builtin:shell
          with:
            command: echo "✓ Success"
      onFailure:
        - name: Notify Failure
          uses: builtin:shell
          with:
            command: echo "✗ Failed"
    steps:
      - name: Main Task
        uses: builtin:shell
        with:
          command: echo "Running main task..."
```

### Approval Steps

```yaml
steps:
  - name: Manual Approval
    uses: builtin:approval
    with:
      message: "Deploy to production?"
      timeout: 3600  # seconds, default: 1 hour
      approvers: ["admin@example.com"]  # optional
```

**Note:** Use `kb wf approve <runId> <stepId>` to approve or reject the step.

### Artifact Merge

```yaml
jobs:
  aggregate:
    artifacts:
      merge:
        strategy: json-merge  # or 'append', 'overwrite'
        from:
          - runId: abc123
            jobId: test
          - runId: def456
            jobId: lint
```

**Strategies:**
- `append`: Concatenate arrays or strings
- `overwrite`: Use last value
- `json-merge`: Deep merge JSON objects

## Configuration

Workflow settings can be configured in `kb.config.json`:

```json
{
  "workflow": {
    "workspaces": [".kb/workflows/**/*.yml", "workflows/**/*.yml"],
    "plugins": true,
    "maxDepth": 2,
    "remotes": [
      {
        "name": "kb-labs-official",
        "url": "https://github.com/kb-labs/workflows",
        "ref": "main",
        "path": "workflows"
      }
    ],
    "budget": {
      "enabled": true,
      "limit": 1000,
      "period": "day",
      "action": "warn"
    },
    "defaults": {
      "mode": "wait",
      "inheritEnv": true
    }
  }
}
```

### Remote Marketplaces

Configure remote workflow sources:

```json
{
  "workflow": {
    "remotes": [
      {
        "name": "my-marketplace",
        "url": "https://github.com/user/workflows",
        "ref": "main",
        "path": "workflows"
      }
    ]
  }
}
```

### Budget Control

Configure budget tracking and limits:

```json
{
  "workflow": {
    "budget": {
      "enabled": true,
      "limit": 1000,
      "period": "day",  // or "run", "week", "month"
      "action": "warn"  // or "fail", "cancel"
    }
  }
}
```

## Examples

See `kb-labs-workflow/packages/workflow-contracts/examples/` for complete workflow examples:
- `nested-workflow.yml` - Nested workflows example
- `conditional-deployment.yml` - Conditional execution example
- `workflow-with-hooks.yml` - Job hooks example
- `plugin-*.yml` - Plugin workflow examples
