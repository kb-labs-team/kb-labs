---
id: S-298
title: Incremental tasks notice new untracked inputs
persona: developer
area: tooling
priority: P1
status: active
release: false
modes: [local]
surfaces: [cli]
---

## Goal

As a workspace developer, I can add a source file without staging it and trust
that the next cached task run uses every matching local input, including an
ignored source file, while declared generated outputs stay out of producer inputs.

## Preconditions

Use a Git workspace with a declared task whose local `inputs` glob matches a
package source directory and whose `outputs` glob names its generated files.
The workspace has a successful cached task result before adding the new file.

## Steps

| # | Action | Expected |
|---|---|---|
| S-298.1 | Add a nonignored source file matching the task's local `inputs` glob without staging it, then run `kb-devkit run <task>` again. | The task runs instead of reporting a cache hit, and its generated output reflects the new file. |
| S-298.2 | Declare a file under `dist/` as the output of a `generate` task and the local input of its dependent `build` task; ignore the file in Git, remove it after a successful run, then run the build again. | The `generate` task reports a cache hit and restores the ignored file; the `build` task also reports a cache hit using the restored generated input. The generated file is excluded from `generate`'s own key. |
| S-298.3 | Add an untracked file outside the task's declared local inputs, then run the task again. | The task remains a cache hit; untracked files outside its declared inputs do not broaden the cache key. |
| S-298.4 | Build package B after its workspace dependency A using `deps: ["^build"]`; have B read A's source directly without a `^` input, then add an untracked source file in A and run the build again. | A rebuilds from the new source, and B also rebuilds with output reflecting A's source list instead of restoring a stale cached result. |
| S-298.5 | Declare a task prerequisite that writes a file but has no `outputs:` patterns, then run its dependent cached task twice. | The prerequisite and dependent execute each time because the prerequisite's side effects cannot be restored or checked from a declared output manifest. |
| S-298.6 | Add a Git-ignored source file matching the task's declared local `inputs` glob, then run the task again. | The task runs and its output reflects the ignored source; Git ignore status does not remove a declared input. |
| S-298.7 | Change an untracked source in the first package of a raw → generate → bundle → test prerequisite chain, then run the final task with `--affected`. | Affected selection reaches the final consumer; every prerequisite task rebuilds in order and the final output reflects the new source. |
| S-298.8 | Add an untracked source to a workspace dependency package with no task variant, where a consumer task reads that source directly and declares `^generate`. | The consumer cache key changes and its output includes the new file, even though the source package has no task variant. |
| S-298.9 | In one package, declare `raw → generate → test` prerequisites, add an untracked source to the raw task input, then run `test --affected`. | The package is selected as dirty through the task predecessor chain; each task rebuilds and the final output reflects the added source. |
| S-298.10 | Add untracked source files under a source-only aggregate package and a nested workspace child. | The aggregate dependency digest changes for its own source and stays unchanged for the child-owned source. |
