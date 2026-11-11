# DevLink Commands Reference

Quick reference for all DevLink commands with examples and common use cases.

## Command Overview

| Command | Purpose | Changes Files |
|---------|---------|---------------|
| `plan` | Analyze dependencies | No |
| `freeze` | Lock → Manifests snapshot | `.kb/devlink/lock.json` |
| `apply` | Manifests ← Lock | `*/package.json` |
| `apply-lock` | Manifests ← Lock (sync only) | `*/package.json` |
| `undo` | Revert last operation | Varies |
| `status` | Show current state | No |
| `backups` | Manage backups | No |

## plan - Analyze Workspace Links

**Purpose:** Discover packages and plan how dependencies should be linked based on the selected mode.

```bash
# Basic plan (auto mode)
kb devlink plan

# Force local links
kb devlink plan --mode=local

# Treat current folder as a container and include child repositories
kb devlink plan --mode=local --container

# Explicit roots (comma-separated)
kb devlink plan --roots=/work/repo-a,/work/repo-b

# JSON output
kb devlink plan --json
```

**Tips:**
- Use `--container` when running from an umbrella directory that hosts multiple repos (e.g. `kb-labs/`).
- Combine `--container` with `--mode=local` to ensure cross-repo links resolve to local paths instead of npm.
- Without additional flags the command keeps legacy behaviour and only scans the current repository.

## freeze - Create Lock Snapshot

**Purpose:** Capture current dependency state into lock file

```bash
# Basic freeze (merge with existing)
kb devlink lock create

# Replace entire lock
kb devlink lock create --replace

# Use exact versions
kb devlink lock create --pin=exact

# Use caret versions (default)
kb devlink lock create --pin=caret

# Remove stale entries
kb devlink lock create --prune

# Preview without writing
kb devlink lock create --dry-run
```

**What happens:**
1. Scans all package.json files
2. Resolves versions from pnpm-lock.yaml
3. Creates/updates `.kb/devlink/lock.json`
4. Backs up old lock.json to `type.freeze/`
5. Auto-cleanup old backups

**Output:**
```
🔒 DevLink Freeze
✓ Lock file created
  Path: .kb/devlink/lock.json
  Pin mode: caret
  Frozen packages: 331
```

## apply - Apply Lock to Manifests

**Purpose:** Modify package.json files according to lock

```bash
# Apply with local links (development)
kb devlink apply --mode=local

# Apply with workspace protocol
kb devlink apply --mode=workspace

# Apply with yalc
kb devlink apply --mode=yalc

# Preview changes
kb devlink apply --dry-run

# Skip confirmation
kb devlink apply --yes
```

**What happens:**
1. Reads `.kb/devlink/lock.json`
2. Backs up current package.json files to `type.apply/manifests/`
3. Modifies dependencies in package.json
4. Changes protocols (e.g., `workspace:*` → `link:../path`)
5. Auto-cleanup old backups

**Example change:**
```json
// Before apply
"dependencies": {
  "@kb-labs/cli-core": "workspace:*"
}

// After apply --mode=local
"dependencies": {
  "@kb-labs/cli-core": "link:../core"
}
```

## apply-lock - Sync Manifests to Lock

**Purpose:** Update package.json versions to match lock (no protocol changes)

```bash
# Sync all manifests to lock versions
kb devlink apply-lock --yes

# Preview
kb devlink apply-lock --dry-run
```

**Difference from `apply`:**
- Only updates versions
- Doesn't change protocols (workspace/link/npm)
- Faster and safer for version sync

## undo - Revert Last Operation

**Purpose:** Restore files from last backup

```bash
# Preview undo
kb devlink rollback --dry-run

# Undo last operation
kb devlink rollback

# Undo specific backup (future)
kb devlink rollback --backup 2025-10-19T14-39-33.311Z
```

**What gets restored:**

| Last Operation | Restores | Doesn't Touch |
|----------------|----------|---------------|
| freeze | lock.json | package.json |
| apply | package.json files | lock.json |

**Safety:**
- Marks journal as "undone" (can't undo twice)
- Dry-run shows exact changes
- Validates backup exists

## status - Check Current State

**Purpose:** Show comprehensive DevLink status

```bash
# Full status
kb devlink status

# One-liner for CI
kb devlink status --short

# JSON output
kb devlink status --json

# Filter warnings
kb devlink status --warnings warn

# CI mode (exit code 2 on errors)
kb devlink status --ci
```

**Shows:**
- Current mode and source
- Last operation with age
- Undo availability
- Lock statistics
- Manifest differences (lock vs actual)
- Health warnings
- Suggested actions

**Example output:**
```
📊 DevLink Status

🧭 Context
  Mode:           local via plan
  Last operation: freeze  •  5m ago
  Undo available: yes    →  kb devlink rollback
  Backup:         2025-10-19T14-39-33Z

🔒 Lock
  Consumers: 33   Deps: 331   Sources: workspace 34 • npm 297

📦 Snapshot (lock vs manifests)
  @kb-labs/cli-commands (3 changes)
    ⚠  @kb-labs/cli-core [dep]
       workspace:* → link:../core
       ^^^^^^^^^^^    ^^^^^^^^^^^^^
       (was)          (now)

⚠️  Warnings (1)
  ⚠ [WARN] LOCK_MISMATCH: Manifest differs from lock in 35 dependencies

💡 Next actions
  • Sync manifests to lock: kb devlink apply-lock --yes  [safe]
  • Revert last operation: kb devlink rollback  [safe]
```

## backups - Manage Backups

**Purpose:** List, protect, validate, and cleanup backups

```bash
# List all backups
kb devlink backup list

# Filter by type
kb devlink backup list --type freeze

# Limit output
kb devlink backup list --limit 10

# JSON output
kb devlink backup list --json

# Protect backup (won't auto-delete)
kb devlink backup list --protect 2025-10-19T14-39-33.311Z

# Unprotect backup
kb devlink backup list --unprotect 2025-10-19T14-39-33.311Z

# Preview cleanup
kb devlink backup list --prune --dry-run

# Cleanup old backups
kb devlink backup list --prune

# Custom retention
kb devlink backup list --prune --keep 10 --keep-days 7 --min-age 2h
```

**Output:**
```
📦 DevLink Backups (2 total)

  2025-10-19T14-39-33.311Z  •  5m ago  •  freeze  •  331 deps ✓ lock
  2025-10-19T14-37-35.449Z  •  2m ago  •  apply   •  24 manifests

💡 Use: kb devlink rollback --backup <timestamp>
💡 Cleanup: kb devlink backup list --prune
```

**Protected backups:**
```
  2025-10-19T14-39-33.311Z  •  5m ago  •  freeze  •  331 deps ✓ lock 🔒
                                                                       ^^^
                                                                    protected
```

## Common Scenarios

### Scenario 1: Switch to Local Development

```bash
# 1. Check current state
kb devlink status

# 2. Create snapshot
kb devlink lock create --pin=caret

# 3. Switch to local links
kb devlink apply --mode=local

# 4. Verify
kb devlink status --short
# Output: mode=local op=apply(2s) diff:+0~35-0 undo=yes

# Now edits propagate instantly via link:
```

### Scenario 2: Back to Workspace Protocol

```bash
# Simply undo the apply
kb devlink rollback

# Or apply with workspace mode
kb devlink apply --mode=workspace
```

### Scenario 3: Lock is Out of Sync

Status shows warnings:
```
⚠ [WARN] LOCK_MISMATCH: Manifest differs from lock in 35 dependencies
```

**Solution:**
```bash
# Option 1: Update manifests to match lock
kb devlink apply-lock --yes
pnpm install

# Option 2: Update lock to match manifests
kb devlink lock create --replace
```

### Scenario 4: Protect Pre-Release Snapshot

```bash
# 1. Freeze before release
kb devlink lock create --replace --pin=exact

# 2. Get latest backup timestamp
BACKUP=$(kb devlink backup list --limit 1 --json | grep -o '"timestamp":"[^"]*"' | head -1 | cut -d'"' -f4)

# 3. Protect it
kb devlink backup list --protect $BACKUP

# 4. Verify
kb devlink backup list --limit 1
# Shows: ... ✓ lock 🔒
```

### Scenario 5: Cleanup Old Backups

```bash
# Check what would be removed
kb devlink backup list --prune --dry-run

# Shows:
# Would remove: 15
# Will keep: 20
# Protected: 1

# Actually cleanup
kb devlink backup list --prune
```

## Key Differences

### freeze vs apply

| Aspect | freeze | apply |
|--------|--------|-------|
| **Direction** | Manifests → Lock | Lock → Manifests |
| **Modifies** | lock.json | package.json files |
| **Backs up** | Old lock.json | Old package.json files |
| **Undo restores** | lock.json | package.json files |
| **Use when** | Capturing state | Switching modes |

### apply vs apply-lock

| Aspect | apply | apply-lock |
|--------|-------|------------|
| **Changes** | Protocols + versions | Only versions |
| **Example** | `workspace:*` → `link:../path` | `^1.0.0` → `^2.0.0` |
| **Use when** | Switching modes | Syncing versions |
| **Speed** | ~200ms | ~100ms |

## Tips & Tricks

### 1. Check Before Acting

Always run status first:
```bash
kb devlink status
# Review warnings and suggestions before acting
```

### 2. Use Dry-Run

Preview changes before committing:
```bash
kb devlink lock create --dry-run
kb devlink apply --dry-run
kb devlink rollback --dry-run
kb devlink backup list --prune --dry-run
```

### 3. Leverage Short Format for Scripts

```bash
STATUS=$(kb devlink status --short)
echo $STATUS
# mode=local op=freeze(5m) diff:+0~35-4 undo=yes

# Parse in scripts
if echo $STATUS | grep -q "undo=yes"; then
  echo "Can undo last operation"
fi
```

### 4. Monitor Backup Health

```bash
# Regular check
kb devlink status | grep -A 5 "Context"

# List backups
kb devlink backup list --limit 5

# Cleanup periodically
kb devlink backup list --prune
```

### 5. Protect Release Snapshots

```bash
# Tag and protect release backups
kb devlink lock create --pin=exact
kb devlink backup list --protect <latest-timestamp>
```

## Error Codes

| Exit Code | Meaning |
|-----------|---------|
| 0 | Success |
| 1 | User error (invalid args, not found) |
| 2 | Integrity/validation failed (--ci mode) |

## Performance

| Operation | Typical Time |
|-----------|-------------|
| status | 8-10ms |
| list backups | <5ms |
| freeze | 200-300ms |
| apply | 150-200ms |
| undo | 50-100ms |
| cleanup | <100ms |

