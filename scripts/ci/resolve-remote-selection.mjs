#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidateBaseRef, candidateFullFallbackReason, candidateSelectionBase } from './remote-selection-base.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const verificationProfile = JSON.parse(readFileSync(new URL('./verification-profile.json', import.meta.url), 'utf8'));
const profile = process.argv[2];
const outputPath = process.argv[3];
const executable = process.argv[4];
const defaultBranch = process.env.DEFAULT_BRANCH;
if (!['stream', 'candidate'].includes(profile) || !outputPath || !executable || (profile === 'stream' && !defaultBranch)) {
  throw new Error('A supported profile, output path, and kb-devkit executable are required; stream selection also requires DEFAULT_BRANCH.');
}
let baseRef;
let selectionBaseSha;
let fullSelection = false;
let forcedFullReason = '';
const emptyTree = spawnSync('git', ['hash-object', '-t', 'tree', '--stdin'], { cwd: root, input: '', encoding: 'utf8' });
if (emptyTree.error || emptyTree.status !== 0) {
  throw new Error(`Could not resolve the full-selection empty-tree base ref; run git hash-object -t tree --stdin. ${emptyTree.error?.message || emptyTree.stderr}`);
}
const emptyTreeSha = emptyTree.stdout.trim();
const policy = candidateSelectionBase({
  branch: process.env.REMOTE_REF_NAME || '',
  requestedBaseRef: process.env.REMOTE_BASE_REF || '',
  emptyTreeRef: emptyTreeSha,
});
forcedFullReason = policy.fullReason;
fullSelection = Boolean(forcedFullReason);
let requestedBaseRef = policy.baseRef;
if (!fullSelection) {
  const resolved = spawnSync('git', ['rev-parse', requestedBaseRef], { cwd: root, encoding: 'utf8' });
  fullSelection = Boolean(resolved.error || resolved.status !== 0);
  if (fullSelection) forcedFullReason ||= 'full: candidate base could not be resolved; selected the complete workspace';
  const resolvedBaseSha = fullSelection ? '' : resolved.stdout.trim();
  const headSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  const headReason = candidateFullFallbackReason({ baseSha: resolvedBaseSha, headSha });
  if (headReason) {
    fullSelection = true;
    forcedFullReason ||= headReason;
  }
  const mergeBase = fullSelection ? undefined : spawnSync('git', ['merge-base', requestedBaseRef, 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (mergeBase && (mergeBase.error || mergeBase.status !== 0)) {
    fullSelection = true;
    forcedFullReason ||= 'full: candidate base could not be merged with HEAD; selected the complete workspace';
  }
  selectionBaseSha = fullSelection ? emptyTreeSha : mergeBase.stdout.trim();
} else {
  selectionBaseSha = emptyTreeSha;
}
if (fullSelection) {
  baseRef = emptyTreeSha;
} else {
  const profileBaseRef = profile === 'stream' ? `${requestedBaseRef}...HEAD` : requestedBaseRef;
  baseRef = candidateBaseRef({ profile, baseRef: profileBaseRef, emptyTreeRef: emptyTreeSha });
}

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'kb-remote-selection-'));
const changedFilesPath = path.join(temporaryRoot, 'changed-files.json');
const runChangedFiles = () => spawnSync(process.execPath, ['scripts/ci/remote-changed-files.mjs'], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, VERIFICATION_PROFILE: profile, KB_DEVKIT_BASE_REF: baseRef, KB_REMOTE_CHANGED_FILES_PATH: changedFilesPath },
});
const runAffected = () => spawnSync(executable, ['--config', path.join(root, 'devkit.yaml'), 'affected', '--changed-files-file', changedFilesPath, '--json'], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, VERIFICATION_PROFILE: profile, KB_DEVKIT_BASE_REF: baseRef, KB_REMOTE_CHANGED_FILES_PATH: changedFilesPath },
});
const readAffectedSelection = (result) => {
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`kb-devkit affected selection failed (exit ${result.status}): ${result.stderr || result.stdout}`);
  let envelope;
  try {
    envelope = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`kb-devkit affected --json returned invalid JSON: ${error.message}`);
  }
  const packages = envelope?.data?.packages;
  const internalToolPackages = envelope?.data?.internalToolPackages;
  const selectionReason = envelope?.data?.selectionReason;
  if (envelope?.ok !== true || !Array.isArray(packages) || packages.some((name) => typeof name !== 'string' || !name)) {
    throw new Error('kb-devkit affected --json returned an invalid package selection. Rerun the remote verification prepare job.');
  }
  if (typeof selectionReason !== 'string') throw new Error('kb-devkit affected --json returned an invalid selection reason. Rerun the remote verification prepare job.');
  if (!Array.isArray(internalToolPackages)) throw new Error('kb-devkit affected --json returned no internal-tool package selection. Rerun the remote verification prepare job.');
  return { packages, internalToolPackages, selectionReason };
};
try {
  let changed = runChangedFiles();
  if ((changed.error || changed.status !== 0) && profile === 'candidate' && !fullSelection) {
    forcedFullReason = 'full: candidate diff computation failed; selected the complete workspace';
    fullSelection = true;
    baseRef = emptyTreeSha;
    selectionBaseSha = emptyTreeSha;
    changed = runChangedFiles();
  }
  if (changed.error) throw changed.error;
  if (changed.status !== 0) throw new Error(`Remote changed-path selection failed (exit ${changed.status}): ${changed.stderr || changed.stdout}`);
  const changedPaths = JSON.parse(readFileSync(changedFilesPath, 'utf8'));
  if (!Array.isArray(changedPaths)) throw new Error('Remote changed-path selection returned an invalid path list.');
  const emptyDiffReason = candidateFullFallbackReason({ changedPathCount: changedPaths.length });
  if (emptyDiffReason && !fullSelection) {
    forcedFullReason = emptyDiffReason;
    fullSelection = true;
    baseRef = emptyTreeSha;
    selectionBaseSha = emptyTreeSha;
    changed = runChangedFiles();
    if (changed.error || changed.status !== 0) throw new Error(`Full changed-path selection failed (exit ${changed.status}): ${changed.stderr || changed.stdout || changed.error?.message}`);
  }
  let result = runAffected();
  let selection;
  try {
    selection = readAffectedSelection(result);
  } catch (error) {
    if (profile !== 'candidate' || fullSelection) throw error;
    forcedFullReason = 'full: affected computation failed; selected the complete workspace';
    fullSelection = true;
    baseRef = emptyTreeSha;
    selectionBaseSha = emptyTreeSha;
    changed = runChangedFiles();
    if (changed.error || changed.status !== 0) throw new Error(`Full changed-path selection failed (exit ${changed.status}): ${changed.stderr || changed.stdout || changed.error?.message}`);
    result = runAffected();
    selection = readAffectedSelection(result);
  }
  let { packages, internalToolPackages, selectionReason } = selection;
  const emptyAffectedReason = candidateFullFallbackReason({ changedPathCount: changedPaths.length, packages });
  if (emptyAffectedReason && !fullSelection) {
    forcedFullReason = emptyAffectedReason;
    fullSelection = true;
    baseRef = emptyTreeSha;
    selectionBaseSha = emptyTreeSha;
    changed = runChangedFiles();
    if (changed.error || changed.status !== 0) throw new Error(`Full changed-path selection failed (exit ${changed.status}): ${changed.stderr || changed.stdout || changed.error?.message}`);
    result = runAffected();
    selection = readAffectedSelection(result);
    ({ packages, internalToolPackages, selectionReason } = selection);
  }
  if (fullSelection && packages.length === 0) {
    throw new Error(`${forcedFullReason || 'full: full selection'}; no workspace packages were returned.`);
  }
  const stages = [...verificationProfile.independentTestStages[profile], ...verificationProfile.buildDependentTestStages[profile]];
  const stagePackages = {};
  for (const stage of stages) {
    const definition = verificationProfile.stages[stage];
    if (definition.runner !== 'kb-devkit-test-package') continue;
    if (typeof definition.packageManifest !== 'string' || !definition.packageManifest) throw new Error(`Verification stage ${stage} needs a registered package manifest.`);
    const manifest = JSON.parse(readFileSync(path.join(root, definition.packageManifest), 'utf8'));
    if (typeof manifest.name !== 'string' || !manifest.name) throw new Error(`Verification stage ${stage} package manifest ${definition.packageManifest} has no package name.`);
    stagePackages[stage] = [manifest.name];
  }
  const finalChangedPaths = JSON.parse(readFileSync(changedFilesPath, 'utf8'));
  const mode = fullSelection || selectionReason.startsWith('full:') ? 'full' : 'affected';
  const reason = forcedFullReason || (mode === 'full' && !selectionReason ? 'full: candidate has no integration base ref' : selectionReason);
  writeFileSync(outputPath, `${JSON.stringify({ ok: true, data: { packages, internalToolPackages, stagePackages, changedPathCount: finalChangedPaths.length, selectionReason: reason, mode, baseSha: selectionBaseSha }, selectedPackageCount: packages.length })}\n`);
  process.stdout.write(`Resolved ${packages.length} package(s) from ${finalChangedPaths.length} path(s) using kb-devkit (${reason}).\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
