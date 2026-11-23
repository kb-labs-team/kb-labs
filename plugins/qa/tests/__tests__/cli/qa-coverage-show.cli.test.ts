import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@kb-labs/sdk', async (importOriginal) => {
  void importOriginal;
  return {
    defineCommand: (command: unknown) => command,
    useConfig: vi.fn().mockResolvedValue(null),
  };
});

import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
});
