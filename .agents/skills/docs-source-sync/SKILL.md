---
name: docs-source-sync
description: Keep KB Labs documentation aligned with code by updating source-backed examples, precise page ownership zones, and the MR review queue. Use when changing docs, their source map, sitemap ownership, or docs staleness checks.
---

# Documentation source sync

Use this workflow when editing `sites/web/apps/docs/` content or its source-to-doc mapping.

For guidance on writing prose and useful copyable examples, see [docs-authoring](../docs-authoring/SKILL.md).

## How to choose the mechanism

- If code contains a canonical literal example (currently CLI manifest examples), use an allowlisted source-backed MDX fragment such as `<CommandExamples command="workflow run" match="--input" />`.
- If the page contains explanatory prose, architecture, or scenario-specific guidance, keep it in MDX and add a narrow `owners` zone in `sitemap.config.json` for the source areas that can invalidate it.
- Treat an explicit generated source reference as authoritative for that file. Broad owner matches for the same file are suppressed; other owner matches are heuristic review hints, not claims that a page is stale.
- Do not add a time-based review date as a substitute for a code dependency. External facts and narrative content may need a separate review policy.

## Editing and verification

1. Read the affected page and its cited implementation before changing examples or ownership zones. Prefer the narrowest stable source path that actually controls the documented behavior.
2. Add source paths only to `lib/doc-source-map.mjs`'s explicit allowlist; MDX must not choose arbitrary file paths or executable expressions.
3. Regenerate committed source snapshots with `pnpm --filter @kb-labs/docs-site docs:source-sync` after changing an allowlisted source.
4. Run `pnpm --filter @kb-labs/docs-site docs:source-check` and `pnpm --filter @kb-labs/docs-site test`.
5. Exercise the staleness queue with `CHANGED_FILES='path/from/repo/root.ts' node scripts/docs-staleness.mjs` from `sites/web/apps/docs`. Confirm exact links return only their directly linked pages, and that matching source zones are backed by existing, page-relevant paths. More-specific zones suppress broader fallback zones.
6. In MR notes, distinguish exact source references from heuristic owner-zone candidates. Update prose only when the code change demonstrates it is stale; otherwise record why it remains accurate.

Read `sites/web/apps/docs/CONVENTIONS.md` for the current MDX and mapping conventions.
