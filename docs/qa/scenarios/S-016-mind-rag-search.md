---
id: S-016
title: Mind — Index and search project content
persona: solo-developer
area: mind
priority: P1
status: active
release: false
modes: [local, secured]
surfaces: [cli]
---

## Goal

A developer uses the marketplace-installed Mind plugin to index a project and retrieve relevant source references.

## Prerequisites

- [ ] The Mind plugin is available from the marketplace and installed in the project.
- [ ] The platform has a configured vector-store adapter.

## Steps

| # | Action | Expected |
|---|---|---|
| S-016.1 | Run `kb mind index update` | Indexing completes and reports the number of files indexed. |
| S-016.2 | Run `kb mind status` | Output includes the indexed file count and last-index time. |
| S-016.3 | Run `kb mind search --text "how does authentication work"` | Results include matching source excerpts with file paths and line references. |
| S-016.4 | Run `kb mind search --text "how does authentication work" --json` | Standard output is valid JSON containing the same result references. |
| S-016.5 | Run `kb mind ask --text "explain the plugin system" --agent` | Agent output is valid JSON with `answer` and `sources`; each source identifies a project file. |
| S-016.6 | Unbind the LLM adapter and run the same `kb mind ask` command | The command returns a typed error naming the missing `llm` capability and includes a `kb adapter bind llm <installed-adapter-package>` hint. |

The optional Qdrant failure behavior previously recorded as S-016.7 is covered by
[S-211.1](S-211-optional-adapter-failure-visibility.md#steps).

Mind is an optional marketplace plugin outside the platform core release contour.
