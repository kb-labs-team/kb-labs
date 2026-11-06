---
name: tool-generate
description: Generate new packages, plugins, adapters using kb-devkit generate
---

# Generating Packages with kb-devkit

## Command

```bash
kb-devkit generate <template> --dest <path> --name <pkg-name>
kb-devkit generate <template> --dest <path> --name <pkg-name> --dry-run
kb-devkit generate   # list available templates
```

Templates are declared in the `scaffolding.templates` section of `devkit.yaml`.

## Available Templates

Check what's configured:
```bash
kb-devkit generate
```

Currently registered:

| Template | Path | Use for |
|----------|------|---------|
| `node-lib` | `templates/node-lib` | TypeScript library (`core/*`, `plugins/*`, `adapters/*`, etc.) |
| `go-binary` | `templates/go-binary` | Go CLI binary (cobra + lipgloss, same pattern as `kb-devkit`/`kb-dev`) |

## Template Variables

Available in file contents and file names:

| Variable | Value |
|----------|-------|
| `{{.Name}}` | full package name (`@kb-labs/my-pkg`) |
| `{{.Scope}}` | npm scope (`kb-labs`) |
| `{{.ShortName}}` | name without scope (`my-pkg`) |
| `{{.Version}}` | `0.1.0` |
| `{{.Dest}}` | destination path |

## Common Workflows

### New plugin (one package)

Use the plugin scaffold to create one package whose package name matches its manifest ID:

```bash
kb scaffold run plugin my-plugin --yes
```

The package lives under `.kb/plugins/my-plugin`; its CLI, REST, contracts, and core modules live in `src/`.

### New adapter

```bash
kb-devkit generate adapter --dest adapters/my-adapter --name @kb-labs/adapter-my
```

Adapters need `./manifest` in exports — the template handles this.

### New library package

```bash
kb-devkit generate node-lib --dest core/my-lib --name @kb-labs/my-lib
```

### New daemon/service

```bash
kb-devkit generate node-app --dest plugins/my-plugin/daemon --name @kb-labs/my-plugin-daemon
```

### New Go CLI tool

```bash
kb-devkit generate go-binary --dest tools/my-tool --name my-tool
```

Generates: `main.go`, `go.mod`, `Makefile`, `cmd/root.go`, `cmd/output.go`, `cmd/example.go`, `README.md`.
Pattern matches `kb-devkit` and `kb-dev`: cobra, lipgloss, ldflags version injection.

## After Generating

1. Check the generated files — especially `package.json` deps
2. Add real dependencies for your use case
3. Run the health check:
   ```bash
   kb-devkit check --package @kb-labs/my-pkg
   ```
4. Should be Grade A immediately (that's the point of scaffolding)

## Where Templates Live

Templates are in `infra/devkit/templates/<name>/` (local source) or
declared as npm/git in `devkit.yaml` under `scaffolding.templates`.

To add a new template — add a folder + register in `devkit.yaml`:
```yaml
scaffolding:
  templates:
    my-template:
      source: local
      path: infra/devkit/templates/my-template
```
