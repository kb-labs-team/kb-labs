import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { defineCommand, useConfig, type CLIInput, type CommandResult, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { computeQACaseCoverage, computeQACaseEvidenceCoverage, parseQACatalog, scanQACaseClaims } from '../../core/index.js';
import {
  QA_CASE_EVIDENCE_RUN_SCHEMA,
  type QACaseEvidencePlan,
  QA_CASE_EVIDENCE_PLAN_SCHEMA,
  QA_CASE_RUN_SCHEMA,
  isQACaseClaimKind,
  type QACaseClaimKind,
  type QACaseMode,
  type QACaseRunResult,
  type QACaseEvidenceRunResult,
  type QAPluginConfig,
} from '../../contracts/index.js';
import type { QaCasesCoverageFlags } from './flags.js';
import { resolveCatalogPath } from './qa-cases-utils.js';

function parseRunResult(value: unknown, knownSteps: Set<string>, declaredClaims: Set<string>): QACaseRunResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('result must be an object');
  const record = value as Record<string, unknown>;
  if (record.schema !== QA_CASE_RUN_SCHEMA) {
    throw new Error(`schema must be ${QA_CASE_RUN_SCHEMA}`);
  }
  if (typeof record.runId !== 'string' || !record.runId) throw new Error('runId must be a non-empty string');
  if (record.mode !== 'local' && record.mode !== 'secured') throw new Error('mode must be local or secured');
  if (!Array.isArray(record.claims)) throw new Error('claims must be an array');
  const claims = record.claims.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error(`claims[${index}] must be an object`);
    const claim = item as Record<string, unknown>;
    if (typeof claim.claimId !== 'string' || !knownSteps.has(claim.claimId)) throw new Error(`claims[${index}] references unknown case step ${String(claim.claimId)}`);
    if (!isQACaseClaimKind(claim.kind)) throw new Error(`claims[${index}].kind must be journey, e2e, or unit`);
    if (!declaredClaims.has(`${claim.claimId}:${String(claim.kind)}`)) throw new Error(`claims[${index}] has no matching ${String(claim.kind)} test claim in source`);
    if (claim.status !== 'PASS' && claim.status !== 'FAIL') throw new Error(`claims[${index}].status must be PASS or FAIL`);
    const status: QACaseRunResult['claims'][number]['status'] = claim.status;
    return { claimId: claim.claimId, kind: claim.kind as QACaseClaimKind, status };
  });
  return { schema: QA_CASE_RUN_SCHEMA, runId: record.runId, mode: record.mode, claims };
}

async function verifyEvidenceArtifact(baseDirectory: string, reference: string | undefined, digest: string | undefined): Promise<boolean> {
  if (!reference || !digest || isAbsolute(reference)) return false;
  try {
    const base = realpathSync(baseDirectory);
    const resolved = resolve(base, reference);
    const pathFromBase = relative(base, resolved);
    if (!pathFromBase || pathFromBase === '..' || pathFromBase.startsWith(`..${sep}`) || isAbsolute(pathFromBase)) return false;
    const actual = realpathSync(resolved);
    const actualFromBase = relative(base, actual);
    if (actualFromBase === '..' || actualFromBase.startsWith(`..${sep}`) || isAbsolute(actualFromBase) || !statSync(actual).isFile()) return false;
    const hash = createHash('sha256');
    await new Promise<void>((resolveHash, rejectHash) => {
      const stream = createReadStream(actual);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('error', rejectHash);
      stream.on('end', resolveHash);
    });
    return hash.digest('hex') === digest.toLowerCase();
  } catch {
    return false;
  }
}

async function parseEvidenceRunResult(value: unknown, knownSteps: Set<string>, declaredClaims: Set<string>, artifactDirectory: string, recordPath: string): Promise<QACaseEvidenceRunResult> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('result must be an object');
  const record = value as Record<string, unknown>;
  const allowedFields = new Set(['schema', 'runId', 'mode', 'candidateId', 'profile', 'selection', 'claims']);
  for (const field of Object.keys(record)) if (!allowedFields.has(field)) throw new Error(`unexpected field ${field}`);
  if (record.schema !== QA_CASE_EVIDENCE_RUN_SCHEMA) throw new Error(`schema must be ${QA_CASE_EVIDENCE_RUN_SCHEMA}; legacy evidence cannot satisfy evidence-backed coverage`);
  if (typeof record.runId !== 'string' || !record.runId) throw new Error('runId must be a non-empty string');
  if (record.mode !== 'local' && record.mode !== 'secured') throw new Error('mode must be local or secured');
  if (record.candidateId !== undefined && (typeof record.candidateId !== 'string' || !record.candidateId.trim())) throw new Error('candidateId must be a non-empty string');
  if (record.selection !== undefined && (!Array.isArray(record.selection)
    || !record.selection.every(item => typeof item === 'string' && item.trim()))) {
    throw new Error('selection must be an array of non-empty strings');
  }
  if (!Array.isArray(record.claims)) throw new Error('claims must be an array');
  if (record.profile !== undefined && (typeof record.profile !== 'object' || record.profile === null || Array.isArray(record.profile)
    || Object.keys(record.profile).length === 0 || !Object.values(record.profile).every(value => typeof value === 'string' && value.trim()))) {
    throw new Error('profile must be a non-empty object of non-empty strings');
  }
  const profile = typeof record.profile === 'object' && record.profile !== null && !Array.isArray(record.profile)
    && Object.values(record.profile).every(value => typeof value === 'string')
    ? record.profile as Record<string, string>
    : undefined;
  const claims = await Promise.all(record.claims.map(async (item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error(`claims[${index}] must be an object`);
    const claim = item as Record<string, unknown>;
    const claimFields = new Set(['claimId', 'kind', 'status', 'configRef', 'configDigest', 'logRef', 'logDigest']);
    for (const field of Object.keys(claim)) if (!claimFields.has(field)) throw new Error(`claims[${index}] has unexpected field ${field}`);
    if (typeof claim.claimId !== 'string' || !knownSteps.has(claim.claimId)) throw new Error(`claims[${index}] references unknown case step ${String(claim.claimId)}`);
    if (!isQACaseClaimKind(claim.kind)) throw new Error(`claims[${index}].kind must be journey, e2e, or unit`);
    if (!declaredClaims.has(`${claim.claimId}:${String(claim.kind)}`)) throw new Error(`claims[${index}] has no matching ${String(claim.kind)} test claim in source`);
    if (claim.status !== 'PASS' && claim.status !== 'FAIL') throw new Error(`claims[${index}].status must be PASS or FAIL`);
    for (const field of ['configRef', 'logRef']) if (claim[field] !== undefined && (typeof claim[field] !== 'string' || !claim[field].trim())) throw new Error(`claims[${index}].${field} must be a non-empty string`);
    for (const field of ['configDigest', 'logDigest']) if (claim[field] !== undefined && (typeof claim[field] !== 'string' || !claim[field].trim())) throw new Error(`claims[${index}].${field} must be a non-empty string`);
    const configRef = typeof claim.configRef === 'string' ? claim.configRef : undefined;
    const configDigest = typeof claim.configDigest === 'string' ? claim.configDigest.toLowerCase() : undefined;
    const logRef = typeof claim.logRef === 'string' ? claim.logRef : undefined;
    const logDigest = typeof claim.logDigest === 'string' ? claim.logDigest.toLowerCase() : undefined;
    return {
      claimId: claim.claimId,
      kind: claim.kind as QACaseClaimKind,
      status: claim.status as 'PASS' | 'FAIL',
      ...(configRef ? { configRef, configVerified: await verifyEvidenceArtifact(artifactDirectory, configRef, configDigest) } : { configVerified: false }),
      ...(configDigest ? { configDigest } : {}),
      ...(logRef ? { logRef, logVerified: await verifyEvidenceArtifact(artifactDirectory, logRef, logDigest) } : { logVerified: false }),
      ...(logDigest ? { logDigest } : {}),
    };
  }));
  return {
    schema: QA_CASE_EVIDENCE_RUN_SCHEMA,
    runId: record.runId,
    mode: record.mode,
    ...(typeof record.candidateId === 'string' && record.candidateId.trim() ? { candidateId: record.candidateId } : {}),
    ...(profile ? { profile } : {}),
    ...(Array.isArray(record.selection) ? { selection: [...record.selection] as string[] } : {}),
    recordPath,
    claims,
  };
}

function parseEvidencePlan(value: unknown): QACaseEvidencePlan {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('plan must be an object');
  const plan = value as Record<string, unknown>;
  const fields = new Set(['schema', 'mode', 'candidateId', 'profile']);
  for (const field of Object.keys(plan)) if (!fields.has(field)) throw new Error(`unexpected plan field ${field}`);
  if (plan.schema !== QA_CASE_EVIDENCE_PLAN_SCHEMA.properties.schema.const) throw new Error(`schema must be ${QA_CASE_EVIDENCE_PLAN_SCHEMA.properties.schema.const}`);
  if (plan.mode !== 'local' && plan.mode !== 'secured') throw new Error('plan mode must be local or secured');
  if (typeof plan.candidateId !== 'string' || !plan.candidateId.trim()) throw new Error('plan candidateId must be a non-empty string');
  if (typeof plan.profile !== 'object' || plan.profile === null || Array.isArray(plan.profile)
    || Object.keys(plan.profile).length === 0 || !Object.values(plan.profile).every(value => typeof value === 'string' && value.trim())) {
    throw new Error('plan profile must be a non-empty object of non-empty strings');
  }
  return { schema: 'kb.qa-evidence-plan/v1', mode: plan.mode, candidateId: plan.candidateId, profile: plan.profile as Record<string, string> };
}

export default defineCommand<unknown, CLIInput<QaCasesCoverageFlags>, unknown>({
  id: 'qa:coverage:show',
  description: 'Compute QA case coverage from claims and run results',
  handler: { async execute(ctx: PluginCommandContextV3, input: CLIInput<QaCasesCoverageFlags>): Promise<CommandResult> {
    const cwd = ctx.cwd ?? process.cwd();
    const config = await useConfig<QAPluginConfig>();
    const catalog = parseQACatalog(resolveCatalogPath(cwd, config?.casesPath));
    const scanned = scanQACaseClaims(cwd, catalog.cases);
    const diagnostics = [...catalog.diagnostics, ...scanned.diagnostics];
    const mode = input.flags.mode ?? 'local';
    const level = input.flags.level ?? 'all';
    if (mode !== 'local' && mode !== 'secured') diagnostics.push({ file: '<arguments>', line: 1, message: '--mode must be local or secured' });
    if (level !== 'all' && level !== 'release') diagnostics.push({ file: '<arguments>', line: 1, message: '--level must be all or release' });
    let evidencePlan: QACaseEvidencePlan | undefined;
    if (input.flags.evidence && input.flags['evidence-plan']) {
      try {
        const planPath = resolve(cwd, input.flags['evidence-plan']);
        const parsed: unknown = JSON.parse(readFileSync(planPath, 'utf8'));
        evidencePlan = parseEvidencePlan(parsed);
        if (evidencePlan.mode !== mode) evidencePlan = undefined;
      } catch (error) {
        diagnostics.push({ file: input.flags['evidence-plan'], line: 1, message: `cannot read evidence plan: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    let runs: QACaseRunResult[] = [];
    let evidenceRuns: QACaseEvidenceRunResult[] = [];
    for (const path of (input.flags.run ?? '').split(',').filter(Boolean)) {
      try {
        const value: unknown = JSON.parse(readFileSync(resolve(cwd, path), 'utf8'));
        const candidate = typeof value === 'object' && value !== null && !Array.isArray(value) && 'case_run' in value ? value.case_run : value;
        const knownSteps = new Set(catalog.cases.flatMap(item => item.steps.map(step => step.id)));
        const declaredClaims = new Set(scanned.claims.map(claim => `${claim.stepId}:${claim.kind}`));
        if (input.flags.evidence) evidenceRuns.push(await parseEvidenceRunResult(
          candidate,
          knownSteps,
          declaredClaims,
          dirname(resolve(cwd, path)),
          relative(cwd, resolve(cwd, path)),
        ));
        else runs.push(parseRunResult(candidate, knownSteps, declaredClaims));
      } catch (error) {
        diagnostics.push({ file: path, line: 1, message: `cannot read case run result: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    if (diagnostics.length) {
      const result = { schema: 'kb.qa-case-coverage/v1', mode, releasePassed: false, cases: [], diagnostics };
      if (!input.flags.json) ctx.ui?.warn?.('QA case coverage input is invalid.');
      return { ok: false, error: { code: 'KB_RUNTIME_INPUT_INVALID', message: 'QA case coverage input is invalid', hint: 'Fix the listed case coverage inputs, then rerun `kb qa coverage show`.', diagnostics: diagnostics.map((item) => ({ code: 'KB_QA_CASE_COVERAGE_INPUT_INVALID', severity: 'error', path: item.file, message: item.message })) } };
    }
    const coverage = input.flags.evidence
      ? computeQACaseEvidenceCoverage(catalog.cases, scanned.claims, evidenceRuns, mode as QACaseMode, evidencePlan)
      : computeQACaseCoverage(catalog.cases, scanned.claims, runs, mode as QACaseMode);
    const ok = level === 'all' || coverage.releasePassed;
    if (!input.flags.json) {
      const passed = coverage.cases.filter(item => item.statusResult === 'PASS').length;
      const incomplete = coverage.cases.filter(item => item.statusResult !== 'PASS' && item.statusResult !== 'NOT REQUIRED').length;
      if (ok) ctx.ui?.success?.(`QA cases ${mode}: ${passed} passed, ${incomplete} incomplete.`);
      else ctx.ui?.warn?.(`Release cases are not passing for ${mode}.`);
    }
    return ok ? coverage : {
      ok: false,
      error: {
        code: 'KB_RUNTIME_COMMAND_FAILED',
        message: `Release cases are not passing for ${mode}; rerun with completed results using \`kb qa coverage show --level release --mode ${mode} --run <results.json>\``,
        hint: `Run \`kb qa coverage show --level release --mode ${mode} --run <results.json>\` after completing the release case steps.`,
        diagnostics: input.flags.evidence
          ? [
            ...(!evidencePlan ? [{ code: 'KB_QA_EVIDENCE_PLAN_INCOMPLETE', severity: 'error', path: '<evidence-plan>', message: 'Evidence-backed release evaluation requires a valid independent evidence plan for the selected mode.' }] : []),
            ...coverage.cases.flatMap(item => item.steps
              .filter(step => step.status !== 'PASS' || ('evidenceStatus' in step && step.evidenceStatus !== 'COMPLETE'))
              .map(step => {
                const observedCandidates = 'observedCandidateIds' in step && Array.isArray(step.observedCandidateIds) ? step.observedCandidateIds.join(',') : '';
                const configRefs = 'configRefs' in step && Array.isArray(step.configRefs) ? step.configRefs.map(ref => `${ref.runId}@${ref.runRoot}/${ref.path}#sha256=${ref.sha256}`).join(',') : '';
                const logRefs = 'logRefs' in step && Array.isArray(step.logRefs) ? step.logRefs.map(ref => `${ref.runId}@${ref.runRoot}/${ref.path}#sha256=${ref.sha256}`).join(',') : '';
                return {
                  code: step.status === 'FAIL' ? 'KB_QA_CASE_BEHAVIOR_FAILED' : 'KB_QA_CASE_EVIDENCE_INCOMPLETE',
                  severity: 'error',
                  path: step.stepId,
                  message: `${step.stepId}: result=${step.status}${'evidenceStatus' in step ? `, evidence=${step.evidenceStatus}` : ''}${'expectedCandidateId' in step && step.expectedCandidateId ? `, expectedCandidate=${step.expectedCandidateId}` : ''}${observedCandidates ? `, observedCandidates=${observedCandidates}` : ''}${configRefs ? `, config=${configRefs}` : ''}${logRefs ? `, logs=${logRefs}` : ''}${step.reason ? `; ${step.reason}` : ''}`,
                };
              })),
            ...(coverage.cases.some(item => item.status === 'active' && item.release && item.statusResult !== 'NOT REQUIRED' && item.steps.length === 0)
              || !coverage.cases.some(item => item.status === 'active' && item.release && item.statusResult !== 'NOT REQUIRED' && item.steps.length > 0)
              ? [{ code: 'KB_QA_EVIDENCE_INCOMPLETE', severity: 'error', path: '<release-matrix>', message: `No applicable active release steps are present for ${mode}; the evidence matrix cannot pass.` }]
              : []),
          ]
          : coverage.cases
            .filter(item => item.statusResult !== 'PASS' && item.statusResult !== 'NOT REQUIRED')
            .map(item => ({
              code: 'KB_QA_CASE_COVERAGE_INCOMPLETE',
              severity: 'error',
              path: item.id,
              message: `Case ${item.id} is ${item.statusResult}.`,
            })),
      },
    };
  } },
});
