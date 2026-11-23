import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@kb-labs/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kb-labs/sdk')>();
  return { ...actual, useConfig: vi.fn().mockResolvedValue(null) };
});

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCapturedUI, createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';
import command from '../../../src/cli/commands/qa-cases-inventory.js';

const dirs: string[] = [];

afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('qa:cases-inventory', () => {
  // case: S-314.1
  it('returns source claims with an explicit Release 1 profile policy and undeclared dimensions', async () => {
    const root = join(tmpdir(), `qa-cases-inventory-${Date.now()}-${Math.random()}`);
    dirs.push(root);
    mkdirSync(join(root, 'docs', 'qa', 'scenarios'), { recursive: true });
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'docs', 'qa', 'scenarios', 'S-314.md'), [
      '---', 'id: S-314', 'title: Inventory', 'persona: developer', 'area: qa', 'priority: P1',
      'status: active', 'release: false', 'modes: [local]', 'surfaces: [cli]', '---', '',
      '## Steps', '', '| # | Action | Expected |', '|---|---|---|',
      '| S-314.1 | Run inventory | Profile gaps are explicit |', '',
      '## Profile applicability', '', '| Step | Execution models |', '|---|---|',
      '| S-314.1 | subprocess, worker-pool |', '',
    ].join('\n'));
    writeFileSync(join(root, 'tests', 'inventory.test.ts'), [
      '// case: S-314.1', 'it("reports inventory", () => {});',
    ].join('\n'));
    const { ui } = createCapturedUI();

    const result = await command.execute(
      createMockContext({ ui, cwd: root }) as never,
      mockCLIInput({ flags: { json: true } }) as never,
    );

    expect(result).toMatchObject({
      schema: 'kb.qa-case-evidence-inventory/v1',
      policy: { release1: { requiredOperatingSystems: ['macos', 'linux'], supplementalNonGatingMode: 'secured' } },
      totals: { cases: 1, steps: 1 },
      steps: [{
        stepId: 'S-314.1', ownership: 'CLAIMED',
        profileDeclarations: { operatingSystem: 'UNDECLARED', runtime: 'UNDECLARED', executionModel: 'DECLARED', candidateArtifactIdentity: 'UNDECLARED' },
        profileExpectations: { executionModel: { required: ['subprocess', 'worker-pool'], evaluation: 'NOT EVALUATED' } },
      }],
    });
  });
});
