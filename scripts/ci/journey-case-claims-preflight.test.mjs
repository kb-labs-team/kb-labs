import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { parseQACatalog } from '../../plugins/qa/src/core/cases/catalog.ts';
import { scanQACaseClaims } from '../../plugins/qa/src/core/cases/claims.ts';
import { validateJourneyCaseDeclarations } from './journey-case-claims-preflight.mjs';

test('journey evidence helper references do not create a second case claim', () => {
  const result = validateJourneyCaseDeclarations();

  assert.deepEqual(result.diagnostics, []);
  assert.ok(result.caseCount > 0);
  assert.ok(result.journeyClaimCount > 0);

  const catalog = parseQACatalog(resolve(process.cwd(), 'docs/qa/scenarios'));
  const scan = scanQACaseClaims(process.cwd(), catalog.cases);
  const studioClaims = scan.claims.filter((claim) => (
    claim.id === 'S-120.1' && claim.source === 'e2e/journey/runner.py'
  ));
  assert.equal(studioClaims.length, 1, 'the Playwright evidence helper is not a second journey step claim');
});

test('only registered journey declarations create claims from cases arguments', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-journey-claim-owner-'));
  try {
    const sourceDir = join(root, 'e2e', 'journey');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'sample.py'), [
      'journey.step("declared step", "test", check, cases=["S-001.1"])',
      'run_studio_browser_step(command, env, report, "local", True, cases=["S-001.1"])',
      'helper(evidence, cases=["S-001.1"])',
      'cases = ["S-001.1"]',
      'def step(name, cases=["S-001.1"]):',
      '    pass',
      '',
    ].join('\n'));

    const scan = scanQACaseClaims(root, [{ id: 'S-001', steps: [{ id: 'S-001.1' }] }]);
    assert.equal(scan.claims.length, 1);
    assert.equal(scan.claims[0].id, 'S-001.1');
    assert.equal(scan.diagnostics.length, 3);
    assert.match(scan.diagnostics[0].message, /registered journey declaration/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
