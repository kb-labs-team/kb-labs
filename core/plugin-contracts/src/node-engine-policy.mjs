import { readFileSync } from 'node:fs';

/**
 * @param {unknown} value
 * @param {string} [owner]
 * @returns {{ requiredMajor: number }}
 */
export function parseNodeEnginePolicy(value, owner = 'workspace') {
  if (typeof value !== 'string') {
    throw new Error(`The ${owner} must declare engines.node as MAJOR.x.`);
  }
  const match = /^(0|[1-9]\d*)\.x$/.exec(value);
  if (!match) {
    throw new Error(`Unsupported Node.js engine declaration "${value}"; use exactly MAJOR.x.`);
  }
  return { requiredMajor: Number(match[1]) };
}

/**
 * @param {string} packageManifest
 * @returns {string | undefined}
 */
export function readNodeEngineDeclaration(packageManifest) {
  /** @type {{ engines?: { node?: unknown } }} */
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(packageManifest, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read package manifest ${packageManifest}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const policy = parsed.engines?.node;
  if (policy === undefined) return undefined;
  if (typeof policy !== 'string') {
    throw new Error(`Node.js engine declaration in ${packageManifest} must be a string.`);
  }
  return policy;
}
