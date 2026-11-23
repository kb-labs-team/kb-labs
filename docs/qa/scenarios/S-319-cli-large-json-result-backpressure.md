---
id: S-319
title: CLI — preserve large JSON results through stdout backpressure
persona: developer
area: qa
priority: P1
status: planned
release: false
modes: [local]
surfaces: [cli]
---

## Goal

A developer can consume a complete machine-readable result when a CLI command returns more JSON than the stdout pipe can immediately accept.

## Preconditions

- The QA case catalog is large enough that `kb qa cases list --json` produces a result larger than the stdout pipe capacity.

## Steps

| # | Action | Expected |
|---|---|---|
| S-319.1 | Run `kb qa cases list --json` from the repository root | The command exits 0 and writes one complete, parseable JSON document to stdout containing every catalog case and its steps; output is not truncated and no CLI result error is appended. |
