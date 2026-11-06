---
id: S-275
title: Studio — disclose in-memory analytics lifetime
persona: solo-developer
area: studio
priority: P1
status: active
release: false
modes: [local, secured]
surfaces: [studio]
---

## Goal

Understand that analytics stats from the in-memory fallback describe only the current host process and are not persistent history.

## Prerequisites

- [ ] A local or secured platform with Studio, started with no persistent analytics binding resolved. At the platform root, `kb adapter unbind analytics` removes the binding.

## Steps

| # | Action | Expected |
|---|--------|----------|
| S-275.1 | Open `/analytics/overview` while the in-memory analytics adapter supplies stats | Studio displays real aggregate stats, states plainly that analytics are kept in memory and reset on restart, and shows catalog-owned hint `KB_ANALYTICS_PERSISTENCE_VOLATILE`. It does not present in-memory data as persistent history. |
