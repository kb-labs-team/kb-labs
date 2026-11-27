import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { buildPlan, matchesGlob, parseNameStatus } from './resolve-e2e-zones.mjs';

const zones = [
  { zone: 'mind', watch: ['plugins/mind/**', 'e2e/mind/**'], suites: ['e2e-mind'] },
  { zone: 'launcher', runner: 'launcher', watch: ['tools/kb-create/**'], suites: ['e2e-kb-create'] },
  { zone: 'auth', watch: ['services/gateway/auth/**'], suites: ['e2e-auth', 'e2e-oauth'] },
  {
    zone: '_global',
    mode: 'global',
    watch: ['core/**', 'pnpm-lock.yaml', 'e2e/scripts/**', 'package.json', 'pnpm-workspace.yaml'],
    ignore: ['docs/**', '**/*.md'],
  },
];

test('glob matching accepts zero or more directories for **', () => {
  assert.equal(matchesGlob('plugins/mind/index.ts', 'plugins/mind/**'), true);
  assert.equal(matchesGlob('plugins/mind/src/index.ts', 'plugins/mind/**'), true);
  assert.equal(matchesGlob('services/workflow/index.ts', 'plugins/mind/**'), false);
});

test('zone runner is carried into the shared E2E plan', () => {
  const plan = buildPlan(parseNameStatus('M\ttools/kb-create/v2/catalog/catalog.go\n'), zones);
  assert.deepEqual(plan.selected.map(({ zone, runner, suites }) => ({ zone, runner, suites })), [
    { zone: 'launcher', runner: 'launcher', suites: ['e2e-kb-create'] },
  ]);
});

test('a rename selects the old zone and warns when the new path loses ownership', () => {
  const changes = parseNameStatus('R100\tplugins/mind/src/search.ts\tplugins/search/src/search.ts\n');
  const plan = buildPlan(changes, zones);
  assert.deepEqual(plan.selected.map((zone) => zone.zone), ['mind']);
  assert.ok(plan.warnings.some((warning) => warning.type === 'rename-uncovered'));
});

test('global changes select every zone and docs are ignored', () => {
  const plan = buildPlan(parseNameStatus('M\tcore/types/src/index.ts\nM\tdocs/ci.md\n'), zones);
  assert.deepEqual(plan.selected.map((zone) => zone.zone), ['mind', 'launcher', 'auth']);
  assert.deepEqual(plan.warnings, []);
});

test('shared install and packaging infrastructure is covered globally', () => {
  const plan = buildPlan(parseNameStatus([
    'M\te2e/scripts/pack-all.sh',
    'M\tpackage.json',
    'M\tpnpm-workspace.yaml',
  ].join('\n')), zones);
  assert.deepEqual(plan.selected.map((zone) => zone.zone), ['mind', 'launcher', 'auth']);
  assert.deepEqual(plan.warnings, []);
});

// case: S-262.24
test('legacy-only changes leave active suites out of the plan', () => {
  const globalZone = JSON.parse(readFileSync(new URL('../../e2e/_global/ci.zone.json', import.meta.url), 'utf8'));
  const activeZones = zones.map(zone => zone.mode === 'global' ? globalZone : zone);
  const legacy = 'D\te2e/tests/specs/platform/plugins.spec.ts';
  const active = 'M\te2e/shared/src/auth.ts';
  const plan = buildPlan(parseNameStatus(legacy), activeZones);
  assert.deepEqual(plan.selected, []);
  assert.deepEqual(plan.warnings, []);
  const activePlan = buildPlan(parseNameStatus(active), activeZones);
  assert.deepEqual(activePlan.selected.map(({ zone }) => zone), ['mind', 'launcher', 'auth']);
  assert.deepEqual(buildPlan(parseNameStatus(`${legacy}\n${active}`), activeZones).selected, activePlan.selected);
});
