import { ErrorEnvelopeError } from '@kb-labs/core-platform';
import { ProjectRegistryError } from './errors.js';
import { projectErrorEnvelope } from './envelope.js';

/** Return a required project root or raise the shared catalogued project error. */
export function requireProjectContext(projectRoot: undefined, currentPath?: string): never;
export function requireProjectContext(projectRoot: string, currentPath?: string): string;
export function requireProjectContext(projectRoot: string | undefined, currentPath?: string): string;
export function requireProjectContext(
  projectRoot: string | undefined,
  currentPath: string = process.cwd(),
): string {
  if (projectRoot) {return projectRoot;}
  throw new ErrorEnvelopeError(projectErrorEnvelope(new ProjectRegistryError({ code: 'KB_PROJECT_UNKNOWN', details: { path: currentPath } }, 'This operation requires a registered project context.')));
}
