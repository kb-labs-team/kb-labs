import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CiRunDossier } from '../../contracts/index.js';

/** Reads only dossier-shaped files; a partial artifact never breaks an investigation. */
export function loadCiDossiers(path: string): CiRunDossier[] {
  const dossiers: CiRunDossier[] = [];
  for (const file of findDossierFiles(path)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<CiRunDossier>;
      if (parsed.schemaVersion === 1 && parsed.provider === 'github-actions' && parsed.run?.id) {
        dossiers.push(parsed as CiRunDossier);
      }
    } catch { /* ignore incomplete or manually corrupted evidence */ }
  }
  return dossiers;
}

function findDossierFiles(path: string): string[] {
  if (!existsSync(path)) {return [];}
  if (!statSync(path).isDirectory()) {return [path];}
  const files: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {files.push(...findDossierFiles(child));}
    if (entry.isFile() && entry.name === 'dossier.json') {files.push(child);}
  }
  return files;
}
