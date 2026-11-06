import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The platform onboarding surface consumes this snippet during project setup;
// keep it independent from the launcher's V2 artifact application boundary.
const snippetPath = fileURLToPath(new URL('./CLAUDE.md.snippet', import.meta.url))
const snippet = readFileSync(snippetPath, 'utf8')

describe('CLAUDE.md.snippet', () => {
  it('does not reference the nonexistent `kb plugins list` command', () => {
    // The real command is under the marketplace plugin's `plugins` subgroup
    // (cli/commands/src/commands/system/marketplace/index.ts: 'marketplace plugins list').
    // `kb plugins list` was never a registered command and fails with
    // "Did you mean: kb marketplace plugins list".
    expect(snippet).not.toMatch(/`kb plugins list`/)
  })

  it('references the real `kb marketplace plugins list` command', () => {
    expect(snippet).toMatch(/`kb marketplace plugins list`/)
  })
})
