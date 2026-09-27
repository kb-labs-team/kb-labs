---
name: docs-authoring
description: Write and edit KB Labs technical documentation with accurate, useful examples. Use whenever changing Markdown or MDX documentation, including guides, READMEs, reference pages, and ADRs.
---

# Documentation authoring

When changing documentation, leave the page useful to someone who wants to understand or perform the task—not merely aware that a feature exists. Keep the amount of detail proportional to the change; a copy edit does not need a tutorial.

## Write for use

- Explain what the reader will achieve, when the feature or procedure applies, and any prerequisites or important limitations.
- If a page teaches how to use a command, API, SDK, or configuration, include a concrete copyable example. A prose-only direction such as “pass the inputs to the client” is not enough; show the actual call or config shape. If code is not the right medium, give a concrete request/response, sample file, or actionable checklist instead.
- For procedures, give ordered actions and show the actual command, code, configuration, request, or workflow input the reader needs. Prefer complete, copyable examples over prose like “configure the client here” or “add your settings.”
- Use realistic values and the correct language fence. If a value must be supplied by the reader, identify exactly what to replace and how to obtain it. Do not leave unexplained placeholders, ellipses, pseudocode, or TODOs in examples presented as ready to use.
- Add expected output or a short explanation of the result when it helps readers verify they succeeded. Keep long output to the relevant fields.
- Include a minimal example first; add a complete end-to-end example when it resolves integration questions the minimal example cannot.

## Keep examples grounded in the repository

- Inspect implementation, schemas, CLI manifests, tests, and existing docs before stating behavior. Do not invent commands, flags, APIs, fields, defaults, or output.
- Reuse canonical source examples when available. In the docs site, use an allowlisted `<CommandExamples command="..." />` fragment for supported CLI examples instead of copying a manifest example by hand; filter it with `match` when only one relevant form is needed.
- For code or configuration that cannot be generated, keep the sample valid against the current implementation and link to the most useful source or reference page when that helps future verification.
- Distinguish stable contract from implementation detail. Mention version, platform, permissions, or deployment assumptions that affect whether an example works.
- Link related docs using their canonical routes. Check that links and anchors point to existing pages.

## Finish the edit

- Preserve the page's existing voice, structure, frontmatter, and localization conventions. Update `updatedAt` when the page's substance changes and that field is used by the site.
- Remove obsolete examples and instructions in the same section when they conflict with the new content; do not leave contradictory alternatives.
- Avoid empty headings, placeholder prose, and vague directions without a concrete next action.
- Run the applicable docs checks. For `sites/web/apps/docs`, run `pnpm --filter @kb-labs/docs-site docs:source-check` and `pnpm --filter @kb-labs/docs-site test`; run the docs audit when changing sitemap or page structure. Render/build the page when changes affect MDX components or code rendering.

For source mappings, generated examples, and the MR review queue, also follow [docs-source-sync](../docs-source-sync/SKILL.md).
