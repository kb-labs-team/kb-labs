/**
 * @module @kb-labs/core-config/api/read-kb-config
 * Find + read kb.config.* files (product-level workspace config).
 */

import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { findGitRoot, readConfigFile, type ConfigFileResult } from './read-config';
import { interpolateConfig } from '../env-interpolation.js';

const KB_CONFIG_FILENAMES = [
  'kb.config.jsonc',
  'kb.config.json',
  'kb.config.yaml',
  'kb.config.yml',
  '.kb/kb.config.jsonc',
  '.kb/kb.config.json',
  '.kb/kb.config.yaml',
  '.kb/kb.config.yml',
];

export type KbConfigResult = ConfigFileResult;

export async function findKbConfig(
  cwd: string,
  filenames: string[] = KB_CONFIG_FILENAMES
): Promise<{ path: string | null; tried: string[] }> {
  const tried: string[] = [];
  const gitRoot = await findGitRoot(cwd);
  const stopDir = gitRoot || path.parse(cwd).root;
  let dir = path.resolve(cwd);

  while (true) {
    for (const filename of filenames) {
      const candidate = path.join(dir, filename);
      tried.push(candidate);
      try {
        await fsp.access(candidate);
        return { path: candidate, tried };
      } catch {
        // continue
      }
    }

    if (dir === stopDir || dir === path.dirname(dir)) {
      break;
    }

    dir = path.dirname(dir);
  }

  return { path: null, tried };
}

export interface ReadKbConfigOptions {
  required?: boolean;
  env?: NodeJS.ProcessEnv;
}

/** Read runtime config and resolve the existing `${ENV}` reference syntax. */
export async function readKbConfig(cwd: string, options: ReadKbConfigOptions = {}): Promise<KbConfigResult | null> {
  const raw = await readRawKbConfig(cwd);
  if (!raw) { return null; }
  const env = options.env ?? process.env;
  const required = options.required ?? env.NODE_ENV === 'production';
  return { ...raw, data: interpolateConfig(raw.data, required, env) };
}

/** Read the config exactly as stored. Use this in every read-modify-write path. */
export async function readRawKbConfig(cwd: string): Promise<KbConfigResult | null> {
  const { path } = await findKbConfig(cwd);
  if (!path) {
    return null;
  }
  return readConfigFile(path);
}

