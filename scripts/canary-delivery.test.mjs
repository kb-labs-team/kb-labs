import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { stageCanary, retainCanaries } from './canary-delivery.mjs';
import { platformFlowPolicies } from '../plugins/release/src/core/platform-flow-policy.mjs';
const hash = b => createHash('sha256').update(b).digest('hex');
test('canary registry is a declared test delivery target', () => {
  assert.deepEqual(platformFlowPolicies.platform.deliveryTargets.canary, {registry:'https://npm.kblabs.ru', kind:'test'});
});
test('stages exact manifest bytes, index, checksums, and pointer', () => {
  const root=mkdtempSync(join(tmpdir(),'canary-stage-'));
  const bundle=join(root,'bundle'), output=join(root,'output');
  mkdirSync(join(bundle,'binaries','nested'),{recursive:true});
  const bytes=Buffer.from('binary payload'), index=Buffer.from('{"sealed":true}\n');
  writeFileSync(join(bundle,'binaries','nested','binary'), bytes);
  writeFileSync(join(bundle,'binaries','checksums.txt'), `${hash(bytes)}  kb-create-linux-amd64\n`);
  writeFileSync(join(bundle,'binary-manifest.json'), JSON.stringify({binaries:[{filename:'kb-create-linux-amd64',sha256:hash(bytes)}]}));
  writeFileSync(join(bundle,'release-index.json'), index);
  const tag='v2.121.0-canary.abcdef123-binaries';
  stageCanary(bundle, output, tag, 'candidate-1', []);
  assert.deepEqual(readFileSync(join(output,tag,'kb-create-linux-amd64')),bytes);
  assert.deepEqual(readFileSync(join(output,tag,'release-index.json')),index);
  assert.equal(readFileSync(join(output,tag,'checksums.txt'),'utf8'), `${hash(bytes)}  kb-create-linux-amd64\n${hash(index)}  release-index.json\n`);
  assert.deepEqual(JSON.parse(readFileSync(join(output,'binaries-canary','channel.json'))), {schema:2,channel:'canary',tag,candidateId:'candidate-1',indexDigest:hash(index),history:[tag]});
});
test('retention selects three latest delivered versions with retry deduplication', () => {
  assert.deepEqual(retainCanaries(['v3','v2','v1'],'v4'),{keep:['v4','v3','v2'],remove:['v1']});
  assert.deepEqual(retainCanaries(['v3','v2','v1'],'v3'),{keep:['v3','v2','v1'],remove:[]});
});

test('candidate workflow makes delivery opt-in after immutable upload', async () => {
  const yaml = (await import('js-yaml')).default;
  const workflow = yaml.load(readFileSync(new URL('../.github/workflows/release-build-candidate.yml', import.meta.url), 'utf8'));
  assert.equal(workflow.on.workflow_dispatch.inputs.deliver_canary.default, false);
  const steps = workflow.jobs.build.steps;
  const upload = steps.findIndex(step => step.id === 'upload-candidate');
  const delivery = steps.findIndex(step => step.name === 'Deliver canary');
  assert.ok(delivery > upload);
  assert.equal(steps[delivery].if, 'inputs.deliver_canary');
  assert.equal(steps[delivery].env.NPM_TOKEN, '${{ secrets.CANARY_NPM_TOKEN }}');
  assert.equal(steps[delivery].env.CANARY_RELEASES_SSH_KEY, '${{ secrets.CANARY_RELEASES_SSH_KEY }}');
  assert.equal(steps[delivery].env.CANARY_RELEASES_KNOWN_HOSTS, '${{ secrets.CANARY_RELEASES_KNOWN_HOSTS }}');
  assert.equal(steps[delivery].run, 'bash scripts/deliver-canary-ci.sh');
});

test('real delivery script uploads before moving pointer and prunes only recorded old versions', async () => {
  const {spawnSync} = await import('node:child_process');
  const {copyFileSync, chmodSync, existsSync} = await import('node:fs');
  const root=mkdtempSync(join(tmpdir(),'canary-e2e-'));
  const remote=join(root,'remote'), bin=join(root,'bin'), bundle=join(root,'.kb/release/bundle');
  mkdirSync(join(bundle,'binaries'),{recursive:true}); mkdirSync(remote); mkdirSync(bin); mkdirSync(join(root,'scripts'));
  copyFileSync(fileURLToPath(new URL('./canary-delivery.mjs',import.meta.url)),join(root,'scripts/canary-delivery.mjs'));
  const bytes=Buffer.from('executable'), digest=hash(bytes);
  writeFileSync(join(bundle,'binaries','file'),bytes);
  writeFileSync(join(bundle,'binaries','checksums.txt'),`${digest}  kb-create-linux-amd64\n`);
  writeFileSync(join(bundle,'binary-manifest.json'),JSON.stringify({binaries:[{filename:'kb-create-linux-amd64',sha256:digest}]}));
  writeFileSync(join(bundle,'release-index.json'),'{}');
  writeFileSync(join(bundle,'provenance.json'),JSON.stringify({bundleDigest:'digest'}));
  const old=['v2.0.3-canary.abc-binaries','v2.0.2-canary.abc-binaries','v2.0.1-canary.abc-binaries'];
  for (const tag of old) {mkdirSync(join(remote,tag));writeFileSync(join(remote,tag,'file'),'old');}
  mkdirSync(join(remote,'binaries-canary'));
  writeFileSync(join(remote,'binaries-canary/channel.json'),JSON.stringify({history:old}));
  mkdirSync(join(remote,'unrelated'));writeFileSync(join(remote,'unrelated/file'),'keep');
  writeFileSync(join(bin,'timeout'),'#!/bin/sh\nexit 0\n');
  writeFileSync(join(bin,'rsync'),`#!/bin/bash\nprintf '%s\\n' "$*" >> "$RSYNC_LOG"\nargs=()\nfor arg in "$@"; do\n  case "$arg" in --chmod=D755,F644) continue;; kb-releases@releases.kblabs.ru:./*) arg="${remote}/\${arg#kb-releases@releases.kblabs.ru:./}";; esac\n  args+=("$arg")\ndone\nexec /usr/bin/rsync "\${args[@]}"\n`);
  for (const name of ['timeout','rsync']) chmodSync(join(bin,name),0o755);
  const env={...process.env,PATH:`${bin}:${process.env.PATH}`,HOME:root,RUNNER_TEMP:root,NPM_TOKEN:'secret-token',NODE_AUTH_TOKEN:'secret-token',CANARY_RELEASES_SSH_KEY:'secret-key',CANARY_RELEASES_KNOWN_HOSTS:'secret-host',CANDIDATE_ID:'candidate',COMMIT_SHA:'0123',FLOW:'platform',CHANNEL:'canary',VERSION:'2.0.4-canary.abc',RSYNC_LOG:join(root,'rsync.log')};
  const result=spawnSync('bash',[fileURLToPath(new URL('./deliver-canary-ci.sh',import.meta.url))],{cwd:root,env,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const operations=readFileSync(join(root,'rsync.log'),'utf8').trim().split('\n');
  const upload=operations.findIndex(line => line.includes('/staged/v2.0.4-canary.abc-binaries '));
  const pointer=operations.findIndex(line => line.includes('/staged/binaries-canary '));
  assert.ok(upload >= 0 && pointer > upload);
  assert.ok(operations[upload].includes('--chmod=D755,F644'));
  assert.ok(operations[pointer].includes('--chmod=D755,F644'));
  assert.equal(existsSync(join(remote,old[2])),false);
  assert.equal(readFileSync(join(remote,'unrelated/file'),'utf8'),'keep');
  assert.deepEqual(JSON.parse(readFileSync(join(remote,'binaries-canary/channel.json'))).history,['v2.0.4-canary.abc-binaries',...old.slice(0,2)]);
  writeFileSync(join(bin,'timeout'), '#!/bin/sh\nprintf "registry failed: %s\\n" "$NPM_TOKEN" >&2\nexit 7\n');
  const failed=spawnSync('bash',[fileURLToPath(new URL('./deliver-canary-ci.sh',import.meta.url))],{cwd:root,env,encoding:'utf8'});
  assert.equal(failed.status,7);
  assert.match(failed.stderr,/Canary publish failed/);
  assert.doesNotMatch(failed.stderr,/secret-token/);
  assert.match(failed.stderr,/\[redacted\]/);
});

test('staging refuses a checksum file that disagrees with the binary manifest', () => {
  const root=mkdtempSync(join(tmpdir(),'canary-sums-')), bundle=join(root,'bundle');
  mkdirSync(join(bundle,'binaries'),{recursive:true});
  const bytes=Buffer.from('binary');
  writeFileSync(join(bundle,'binaries','binary'),bytes);
  writeFileSync(join(bundle,'binaries','checksums.txt'), `${'0'.repeat(64)}  kb-create-linux-amd64\n`);
  writeFileSync(join(bundle,'binary-manifest.json'), JSON.stringify({binaries:[{filename:'kb-create-linux-amd64',sha256:hash(bytes)}]}));
  writeFileSync(join(bundle,'release-index.json'),'{}');
  assert.throws(()=>stageCanary(bundle,join(root,'out'),'v2.0.0-canary.abc-binaries','candidate',[]),/checksum/);
});
