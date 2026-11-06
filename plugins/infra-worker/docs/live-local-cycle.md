# Live Local Cycle (Docker + Workspace + Snapshot)

This guide runs a full local cycle for infra-worker:

1. `workspace.materialize`
2. `environment.create` (Docker)
3. `workspace.attach`
4. `snapshot.capture`
5. `snapshot.restore` (optional verification)

## Preconditions

- Docker daemon is running.
- You are in monorepo root:
  - `/Users/kirillbaranov/Desktop/kb-labs`
- Infra worker and adapters are built.

## 1. Build required packages

```bash
cd /Users/kirillbaranov/Desktop/kb-labs

pnpm --filter @kb-labs/adapters-environment-docker build
pnpm --filter @kb-labs/adapters-workspace-localfs build
pnpm --filter @kb-labs/adapters-snapshot-localfs build

pnpm --filter @kb-labs/infra-worker build
```

## 2. Configure platform adapters

Use this preset as source:

- `/Users/kirillbaranov/Desktop/kb-labs/kb-labs-infra-worker-plugin/docs/examples/local-live-platform.config.json`

It enables:

- `environment: @kb-labs/adapters-environment-docker`
- `workspace: @kb-labs/adapters-workspace-localfs`
- `snapshot: @kb-labs/adapters-snapshot-localfs`

## 3. Run prepare command

Example command (from monorepo root):

```bash
kb infra-worker prepare \
  --sourceRef "file:///Users/kirillbaranov/Desktop/kb-labs" \
  --basePath "/Users/kirillbaranov/Desktop/kb-labs/.kb/live-demo/workspace" \
  --createEnvironment true \
  --templateId "node20-local" \
  --ttlMs 3600000 \
  --captureSnapshot true \
  --namespace "demo/local"
```

Expected result payload:

- `workspaceId`
- `environmentId`
- `snapshotId`

## 4. Verify resources

Workspace registry:

```bash
ls -la .kb/runtime/workspace-registry
```

Snapshots:

```bash
ls -la .kb/runtime/snapshots/demo/local
```

Docker container:

```bash
docker ps --format "table {{.ID}}\t{{.Image}}\t{{.Names}}"
```

## 5. Optional snapshot restore check

```bash
kb infra-worker restore-snapshot \
  --snapshotId "<SNAPSHOT_ID>" \
  --workspaceId "<WORKSPACE_ID>" \
  --overwrite true
```

## 6. Cleanup

Destroy environment via API/command flow or manually for local experiments:

```bash
docker rm -f <ENVIRONMENT_ID>
```

Remove local runtime artifacts (optional):

```bash
rm -rf .kb/runtime/workspaces .kb/runtime/workspace-registry .kb/runtime/snapshots
```

## Notes

- This flow is local-first and assumes filesystem visibility between runtime and Docker host.
- For remote Docker/Kubernetes, workspace and snapshot providers should be remote-aware (PVC/object storage).
