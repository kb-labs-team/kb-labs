import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@kb-labs/sdk', async (importOriginal) => {
  void importOriginal;
  return {
    defineCommand: (command: unknown) => command,
    useConfig: vi.fn().mockResolvedValue(null),
  };
});

import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import command from '../../../src/cli/commands/qa-coverage-show.js';

const dirs: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'qa-coverage-evidence-'));
  dirs.push(root);
  mkdirSync(join(root, 'docs', 'qa', 'scenarios'), { recursive: true });
  mkdirSync(join(root, 'e2e', 'journey'), { recursive: true });
  mkdirSync(join(root, 'runs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'qa', 'scenarios', 'S-010-example.md'), [
    '---', 'id: S-010', 'title: Example', 'persona: developer', 'area: qa', 'priority: P1',
    'status: active', 'release: true', 'modes: [local]', 'surfaces: [cli]', '---', '',
    '## Goal', 'Review evidence.', '', '## Steps', '| # | Action | Expected |', '|---|---|---|',
    '| S-010.1 | Run the journey | Result is visible |',
  ].join('\n'));
  writeFileSync(join(root, 'e2e', 'journey', 'claims.py'), 'step("evidence", cases=["S-010.1"])\n');
  return root;
}

function writeEvidence(root: string, claim: Record<string, unknown>): { run: string; plan: string } {
  const run = join(root, 'runs', 'run.json');
  const plan = join(root, 'plan.json');
  writeFileSync(run, JSON.stringify({
    schema: 'kb.qa-case-run/v3', runId: 'run-1', mode: 'local', candidateId: 'candidate-approved',
    profile: { os: 'linux-x64', runtime: 'node-24', surface: 'cli' }, claims: [claim],
  }));
  writeFileSync(plan, JSON.stringify({
    schema: 'kb.qa-evidence-plan/v1', mode: 'local', candidateId: 'candidate-approved',
    profile: { os: 'linux-x64', runtime: 'node-24', surface: 'cli' },
  }));
  return { run, plan };
}

afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('qa:coverage-show evidence mode', () => {
  it('retains step FAIL and incomplete evidence diagnostics for a failed release evaluation', async () => {
    const root = fixture();
    const { run, plan } = writeEvidence(root, {
      claimId: 'S-010.1', kind: 'journey', status: 'FAIL', configRef: 'artifacts/missing-config.json',
      configDigest: 'a'.repeat(64), logRef: 'artifacts/missing.log', logDigest: 'b'.repeat(64),
    });
    const ui = { warn: vi.fn(), success: vi.fn() };
    const result = await command.handler.execute({ ui, cwd: root } as never, { flags: {
      evidence: true, 'evidence-plan': plan, run, level: 'release', mode: 'local', json: false,
    } } as never) as { ok: boolean; error: { code: string; diagnostics?: Array<{ code: string; path?: string; message: string }> } };

    expect(result).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED' } });
    expect(result.error.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'KB_QA_CASE_BEHAVIOR_FAILED', path: 'S-010.1', message: expect.stringContaining('result=FAIL, evidence=INCOMPLETE') }),
    ]));
  });

  it('rejects non-string claim kinds and validates referenced artifacts against their digests', async () => {
    const root = fixture();
    const { run, plan } = writeEvidence(root, { claimId: 'S-010.1', kind: {}, status: 'PASS' });
    const ui = { warn: vi.fn(), success: vi.fn() };
    const malformed = await command.handler.execute({ ui, cwd: root } as never, { flags: {
      evidence: true, 'evidence-plan': plan, run, level: 'release', mode: 'local', json: true,
    } } as never) as { ok: boolean; error: { code: string } };
    expect(malformed).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_INPUT_INVALID' } });

    const config = join(root, 'runs', 'config-redacted.json');
    const log = join(root, 'runs', 'step.log');
    writeFileSync(config, '{"source":"user","secret":"[redacted]"}');
    writeFileSync(log, 'journey passed\n');
    const validRun = writeEvidence(root, {
      claimId: 'S-010.1', kind: 'journey', status: 'PASS',
      configRef: 'config-redacted.json', configDigest: createHash('sha256').update('{"source":"user","secret":"[redacted]"}').digest('hex'),
      logRef: 'step.log', logDigest: createHash('sha256').update('journey passed\n').digest('hex'),
    });
    const complete = await command.handler.execute({ ui, cwd: root } as never, { flags: {
      evidence: true, 'evidence-plan': validRun.plan, run: validRun.run, level: 'release', mode: 'local', json: true,
    } } as never);
    expect(complete).toMatchObject({ schema: 'kb.qa-case-coverage/v2', releasePassed: true, evidencePassed: true });
  });

  it('rejects existing artifacts outside the run record directory even when their digests match', async () => {
    const root = fixture();
    const configText = 'redacted config\n';
    const logText = 'completed journey\n';
    writeFileSync(join(root, 'outside-config.json'), configText);
    writeFileSync(join(root, 'outside.log'), logText);
    const { run, plan } = writeEvidence(root, {
      claimId: 'S-010.1', kind: 'journey', status: 'PASS',
      configRef: '../outside-config.json', configDigest: createHash('sha256').update(configText).digest('hex'),
      logRef: '../outside.log', logDigest: createHash('sha256').update(logText).digest('hex'),
    });
    const ui = { warn: vi.fn(), success: vi.fn() };
    const result = await command.handler.execute({ ui, cwd: root } as never, { flags: {
      evidence: true, 'evidence-plan': plan, run, level: 'release', mode: 'local', json: true,
    } } as never);
    expect(result).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED' } });
    expect(result).toMatchObject({ error: { diagnostics: [expect.objectContaining({ message: expect.stringContaining('evidence=INCOMPLETE') })] } });
  });

  it('keeps legacy case-level coverage diagnostics unchanged', async () => {
    const root = fixture();
    const ui = { warn: vi.fn(), success: vi.fn() };
    const result = await command.handler.execute({ ui, cwd: root } as never, { flags: {
      level: 'release', mode: 'local', json: false,
    } } as never) as { ok: boolean; error: { diagnostics: Array<{ code: string; path: string; message: string }> } };
    expect(result.error.diagnostics).toEqual([
      expect.objectContaining({ code: 'KB_QA_CASE_COVERAGE_INCOMPLETE', path: 'S-010', message: 'Case S-010 is NOT RUN.' }),
    ]);
  });

  it('fails closed for a missing evidence plan and an inapplicable release matrix', async () => {
    const root = fixture();
    const { run } = writeEvidence(root, { claimId: 'S-010.1', kind: 'journey', status: 'PASS' });
    const emptyRoot = fixture();
    const casePath = join(emptyRoot, 'docs', 'qa', 'scenarios', 'S-010-example.md');
    writeFileSync(casePath, readFileSync(casePath, 'utf8').replace('modes: [local]', 'modes: [secured]'));
    const ui = { warn: vi.fn(), success: vi.fn() };
    const missingPlan = await command.handler.execute({ ui, cwd: root } as never, { flags: {
      evidence: true, run, level: 'release', mode: 'local', json: true,
    } } as never);
    expect(missingPlan).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED' } });

    const empty = await command.handler.execute({ ui, cwd: emptyRoot } as never, { flags: {
      evidence: true, level: 'release', mode: 'local', json: true,
    } } as never);
    expect(empty).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED' } });
    expect(empty).toMatchObject({ error: { diagnostics: expect.arrayContaining([
      expect.objectContaining({ code: 'KB_QA_EVIDENCE_PLAN_INCOMPLETE' }),
      expect.objectContaining({ code: 'KB_QA_EVIDENCE_INCOMPLETE', path: '<release-matrix>' }),
    ]) } });
  });

  it('qualifies same relative artifact paths with each run identity and root', async () => {
    const root = fixture();
    const plan = join(root, 'plan.json');
    writeFileSync(plan, JSON.stringify({
      schema: 'kb.qa-evidence-plan/v1', mode: 'local', candidateId: 'candidate-approved',
      profile: { os: 'linux-x64', runtime: 'node-24', surface: 'cli' },
    }));
    const configText = 'redacted config\n';
    const logText = 'passed\n';
    for (const [attempt, runId] of [['one', 'attempt-1'], ['two', 'attempt-2']] as const) {
      const runRoot = join(root, 'runs', attempt);
      mkdirSync(runRoot, { recursive: true });
      writeFileSync(join(runRoot, 'config.json'), configText);
      writeFileSync(join(runRoot, 'step.log'), logText);
      writeFileSync(join(runRoot, 'run.json'), JSON.stringify({
        schema: 'kb.qa-case-run/v3', runId, mode: 'local', candidateId: 'candidate-approved',
        profile: { os: 'linux-x64', runtime: 'node-24', surface: 'cli' },
        selection: ['S-010.1'],
        claims: [{
          claimId: 'S-010.1', kind: 'journey', status: 'PASS',
          configRef: 'config.json', configDigest: createHash('sha256').update(configText).digest('hex'),
          logRef: 'step.log', logDigest: createHash('sha256').update(logText).digest('hex'),
        }],
      }));
    }
    const ui = { warn: vi.fn(), success: vi.fn() };
    const result = await command.handler.execute({ ui, cwd: root } as never, { flags: {
      evidence: true, 'evidence-plan': plan, run: 'runs/one/run.json,runs/two/run.json', level: 'all', mode: 'local', json: true,
    } } as never) as { cases: Array<{ steps: Array<{ configRefs: Array<{ runId: string; runRoot: string; path: string }>; logRefs: Array<{ runId: string; runRoot: string; path: string }> }> }> };
    expect(result.cases[0]?.steps[0]?.configRefs).toEqual([
      { runId: 'attempt-1', runRoot: 'runs/one', path: 'config.json', sha256: createHash('sha256').update(configText).digest('hex') },
      { runId: 'attempt-2', runRoot: 'runs/two', path: 'config.json', sha256: createHash('sha256').update(configText).digest('hex') },
    ]);
    expect(result.cases[0]?.steps[0]?.logRefs.map(ref => [ref.runId, ref.runRoot, ref.path])).toEqual([
      ['attempt-1', 'runs/one', 'step.log'], ['attempt-2', 'runs/two', 'step.log'],
    ]);
  });

  // case: S-315.2
  it('reports lost restored journey artifacts as incomplete without changing the recorded behavior result', async () => {
    const root = fixture();
    const upload = join(root, 'upload');
    const restored = join(root, 'restored');
    const artifacts = join(upload, 'qa-evidence', 'pc001-2');
    mkdirSync(artifacts, { recursive: true });
    const configText = '{"generated":true,"credential":"[REDACTED]"}\n';
    const logText = 'kb-create install completed\n';
    writeFileSync(join(artifacts, 'redacted-config.jsonc'), configText);
    writeFileSync(join(artifacts, 'step-PC-001.2.log'), logText);
    const configDigest = createHash('sha256').update(configText).digest('hex');
    const logDigest = createHash('sha256').update(logText).digest('hex');
    writeFileSync(join(upload, 'installer-case-local-agent-commit-default.json'), JSON.stringify({
      schema: 'kb.service-journey/v1',
      case_run: {
        schema: 'kb.qa-case-run/v3', runId: 'pc001-attempt-1', mode: 'local',
        candidateId: 'candidate-approved',
        profile: { os: 'linux-x64', runtime: 'node-24', surface: 'cli' },
        selection: ['PC-001.2'],
        claims: [{
          claimId: 'S-010.1', kind: 'journey', status: 'PASS',
          configRef: 'qa-evidence/pc001-2/redacted-config.jsonc', configDigest,
          logRef: 'qa-evidence/pc001-2/step-PC-001.2.log', logDigest,
        }],
      },
    }));
    writeEvidence(root, { claimId: 'S-010.1', kind: 'journey', status: 'PASS' });

    cpSync(upload, restored, { recursive: true });
    rmSync(join(restored, 'qa-evidence', 'pc001-2', 'step-PC-001.2.log'));
    const ui = { warn: vi.fn(), success: vi.fn() };
    const result = await command.handler.execute({ ui, cwd: root } as never, { flags: {
      evidence: true, 'evidence-plan': join(root, 'plan.json'),
      run: join(restored, 'installer-case-local-agent-commit-default.json'),
      level: 'release', mode: 'local', json: false,
    } } as never) as { ok: boolean; error: { diagnostics?: Array<{ message: string }> } };

    expect(result.ok).toBe(false);
    expect(result.error.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining('result=PASS, evidence=INCOMPLETE') }),
    ]));
  });
});
