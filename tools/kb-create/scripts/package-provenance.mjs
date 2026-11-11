import { execFileSync } from 'node:child_process';

export function invokePackageProvenanceOwner(digestTool, args, input) {
  if (!digestTool) throw new Error('kb-create-release-index owner is required');
  const output = execFileSync(digestTool, args, {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(output);
}
