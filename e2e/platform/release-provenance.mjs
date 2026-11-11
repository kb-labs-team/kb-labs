import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { invokePackageProvenanceOwner } from 'kb-create/scripts/package-provenance.mjs';

export function prepareReleaseProvenance(directory, revision, digestTool) {
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  if (!Array.isArray(manifest) || manifest.length === 0) {
    throw new Error(`release package manifest is empty: ${directory}`);
  }
  return invokePackageProvenanceOwner(
    digestTool,
    ['provenance', directory, revision],
    JSON.stringify(manifest),
  );
}
