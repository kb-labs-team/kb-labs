#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const baseRef = process.env.KB_DEVKIT_BASE_REF;
const profile = process.env.VERIFICATION_PROFILE;
const manifestPath = process.env.KB_REMOTE_CHANGED_FILES_PATH;
if (!baseRef || !manifestPath || !['stream', 'candidate'].includes(profile)) throw new Error('VERIFICATION_PROFILE, KB_DEVKIT_BASE_REF, and KB_REMOTE_CHANGED_FILES_PATH are required by remote verification selection.');

let candidateBase = baseRef;
if (profile === 'candidate') {
  const objectType = execFileSync('git', ['cat-file', '-t', baseRef], { encoding: 'utf8' }).trim();
  if (objectType === 'commit') {
    candidateBase = execFileSync('git', ['merge-base', baseRef, 'HEAD'], { encoding: 'utf8' }).trim();
  }
}
const args = profile === 'stream'
  ? ['diff', '--name-only', '--no-renames', '--diff-filter=ACDMRTUXB', baseRef, '--']
  : ['diff', '--name-only', '--no-renames', '--diff-filter=ACDMRTUXB', candidateBase, 'HEAD', '--'];
const paths = execFileSync('git', args, { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
writeFileSync(manifestPath, `${JSON.stringify(paths)}\n`);
process.stdout.write(paths.length ? `${paths.join('\n')}\n` : '');
