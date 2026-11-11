---
id: S-123
title: Studio — Use the installed Commit plugin page
persona: solo-developer
area: studio
priority: P1
status: active
release: true
modes: [local, secured]
surfaces: [studio]
---

## Goal

After choosing to install the Commit plugin into a project, use its Studio contribution to inspect changed files and generate a commit plan; uninstalling the plugin removes its page.

## Prerequisites

- [ ] Initialized Git project registered with the platform, containing at least one tracked-file change and no staged commit plan; Commit is not preinstalled in the project's marketplace lock.
- [ ] Commit plugin's exact marketplace version identified; the e2e fixture can test with no LLM adapter and then bind its deterministic test LLM adapter through the normal adapter configuration.

## Steps

| # | Action | Expected |
|---|--------|----------|
| S-123.1 | From the project root run `kb marketplace install @kb-labs/commit@<version>` | The selected project's marketplace lock contains the exact installed Commit version and the package's real files are present under the project plugin installation. |
| S-123.2 | Refresh Studio for that project and open the Commit navigation item | The Commit page is present at `/p/commit` and displays the `Commit Plan` and `Files` tabs. |
| S-123.3 | Open the Files tab | The real changed tracked file and its Git status are listed for the selected project/repository scope. |
| S-123.4 | With no LLM adapter bound, return to Commit Plan and choose `Generate plan` | The real Commit API returns the typed `LLM adapter required` error; Studio shows its `kb adapter bind` hint and does not generate a plan. |
| S-123.5 | Bind the deterministic test LLM adapter using the normal adapter configuration, then choose `Generate plan` | A generated plan lists conventional commit message(s) and the changed files assigned to each; the page does not create a Git commit until the user chooses Apply. |
| S-123.6 | From the project root run `kb marketplace uninstall @kb-labs/commit`, then reload Studio | The Commit package files and lock entry are removed; the Commit navigation item and `/p/commit` contribution are absent for that project. |
