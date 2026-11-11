import { randomUUID } from 'node:crypto';
import { promises as fs, readFileSync, realpathSync } from 'node:fs';
import { resolveKbHome } from '@kb-labs/core-platform';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  AddProjectOptions,
  AddProjectResult,
  ProjectDeclarationState,
  ProjectId,
  ProjectRecord,
  ProjectRegistryFile,
  ProjectStatus,
  ProjectView,
} from '@kb-labs/core-contracts';
import type { IProjectRegistry, ProjectRegistryList } from './interface.js';
import { ProjectRegistryError } from './errors.js';
import { projectErrorEnvelope } from './envelope.js';
import { withFileLock, type FileLockOptions } from './file-lock.js';
import { canonicalizeProjectPath, deriveProjectId, isProjectId } from './project-id.js';

export const PROJECT_REGISTRY_SCHEMA_VERSION = 1;
export const PROJECT_REGISTRY_FILE = 'projects.json';

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const STATUSES: readonly ProjectStatus[] = ['active', 'disabled'];

/** `<root>/state/<projectId>/` — path only, nothing is created. */
export function projectStateDir(root: string, id: ProjectId): string {
  return join(root, 'state', id);
}

export interface ProjectRegistryOptions {
  /** Machine-level root. Defaults to `resolveKbHome(env)`. */
  root?: string;
  env?: NodeJS.ProcessEnv;
  /** Clock, injectable for tests. */
  now?: () => Date;
  lock?: FileLockOptions;
}

interface IdentityMismatchRecord {
  record: ProjectRecord;
  error: ProjectRegistryError;
}

interface RegistrySnapshot {
  file: ProjectRegistryFile;
  identityMismatches: IdentityMismatchRecord[];
}

class ProjectRecordIdentityMismatch extends ProjectRegistryError {
  readonly record: ProjectRecord;

  constructor(file: string, index: number, record: ProjectRecord) {
    const reason = `projects[${index}].id ${record.id} does not match registered path ${record.path}`;
    super({ code: 'KB_PROJECT_REGISTRY_CORRUPT', details: { file, reason } }, `Project registry ${file} is invalid: ${reason}`);
    this.record = record;
  }
}

function corrupt(file: string, reason: string): ProjectRegistryError {
  return new ProjectRegistryError({ code: 'KB_PROJECT_REGISTRY_CORRUPT', details: {
    file,
    reason,
  } }, `Project registry ${file} is invalid: ${reason}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseRecord(value: unknown, file: string, index: number): ProjectRecord {
  const at = `projects[${index}]`;
  if (!isObject(value)) {
    throw corrupt(file, `${at} is not an object`);
  }
  const { id, path, name, status, addedAt, lastUsedAt } = value;
  if (typeof id !== 'string' || !isProjectId(id)) {
    throw corrupt(file, `${at}.id is not a project id`);
  }
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw corrupt(file, `${at}.path is not an absolute path`);
  }
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw corrupt(file, `${at}.name is invalid`);
  }
  if (typeof status !== 'string' || !STATUSES.includes(status as ProjectStatus)) {
    throw corrupt(file, `${at}.status is invalid`);
  }
  if (typeof addedAt !== 'string' || Number.isNaN(Date.parse(addedAt))) {
    throw corrupt(file, `${at}.addedAt is not a timestamp`);
  }
  if (lastUsedAt !== null && (typeof lastUsedAt !== 'string' || Number.isNaN(Date.parse(lastUsedAt)))) {
    throw corrupt(file, `${at}.lastUsedAt is not a timestamp or null`);
  }
  if (deriveProjectId(path) !== id) {
    throw new ProjectRecordIdentityMismatch(file, index, {
      id,
      path,
      name,
      status: status as ProjectStatus,
      addedAt,
      lastUsedAt,
    });
  }
  return { id, path, name, status: status as ProjectStatus, addedAt, lastUsedAt };
}

function parseRegistrySnapshot(raw: string, file: string, recoverIdentityMismatches: boolean): RegistrySnapshot {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw corrupt(file, 'not valid JSON');
  }
  if (!isObject(data)) {
    throw corrupt(file, 'top-level value is not an object');
  }
  const { schemaVersion, projects } = data;
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    throw corrupt(file, 'schemaVersion is missing or not an integer');
  }
  if (schemaVersion !== PROJECT_REGISTRY_SCHEMA_VERSION) {
    throw new ProjectRegistryError({ code: 'KB_PROJECT_REGISTRY_SCHEMA_UNSUPPORTED', details: { file, found: String(schemaVersion), supported: String(PROJECT_REGISTRY_SCHEMA_VERSION) } }, `Project registry ${file} has schemaVersion ${schemaVersion}; this build supports ${PROJECT_REGISTRY_SCHEMA_VERSION}.`);
  }
  if (!Array.isArray(projects)) {
    throw corrupt(file, 'projects is not an array');
  }
  const records: ProjectRecord[] = [];
  const identityMismatches: IdentityMismatchRecord[] = [];
  projects.forEach((entry, index) => {
    try {
      records.push(parseRecord(entry, file, index));
    } catch (error) {
      if (!recoverIdentityMismatches || !(error instanceof ProjectRecordIdentityMismatch)) {
        throw error;
      }
      identityMismatches.push({ record: error.record, error });
    }
  });
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const record of records) {
    if (ids.has(record.id)) {
      throw corrupt(file, `duplicate project id ${record.id}`);
    }
    if (names.has(record.name)) {
      throw corrupt(file, `duplicate project name ${record.name}`);
    }
    ids.add(record.id);
    names.add(record.name);
  }
  return { file: { schemaVersion, projects: records }, identityMismatches };
}

/** Validates the complete raw file. Never repairs: a bad file is reported, not rewritten. */
export function parseRegistryFile(raw: string, file: string): ProjectRegistryFile {
  return parseRegistrySnapshot(raw, file, false).file;
}

/** Write to a sibling temp file, fsync, then rename: readers never see a partial file. */
async function writeFileAtomic(target: string, content: string): Promise<void> {
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, target);
  } catch (error) {
    await fs.unlink(temp).catch(() => undefined);
    throw error;
  }
}

async function hasDeclaration(projectPath: string): Promise<ProjectDeclarationState> {
  try {
    const stat = await fs.stat(join(projectPath, '.kb'));
    return stat.isDirectory() ? 'present' : 'missing';
  } catch {
    return 'missing';
  }
}

async function pathExists(projectPath: string): Promise<boolean> {
  try {
    return (await fs.stat(projectPath)).isDirectory();
  } catch {
    return false;
  }
}

function uniqueName(base: string, taken: ReadonlySet<string>): string {
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '') || 'project';
  const start = cleaned.slice(0, 60);
  if (!taken.has(start)) {
    return start;
  }
  for (let n = 2; ; n += 1) {
    const candidate = `${start}-${n}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

function containingPath<T extends { path: string }>(
  rows: readonly T[], cwd: string,
): T | undefined {
  return rows
    .filter(({ path }) => {
      const rel = relative(path, cwd);
      return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    })
    .sort((left, right) => right.path.length - left.path.length)[0];
}

export function createProjectRegistry(options: ProjectRegistryOptions = {}): IProjectRegistry {
  const root = options.root ? resolve(options.root) : resolveKbHome(options.env);
  const filePath = join(root, PROJECT_REGISTRY_FILE);
  const lockPath = `${filePath}.lock`;
  const now = options.now ?? (() => new Date());

  const readFile = async (): Promise<RegistrySnapshot> => {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { file: { schemaVersion: PROJECT_REGISTRY_SCHEMA_VERSION, projects: [] }, identityMismatches: [] };
      }
      throw error;
    }
    return parseRegistrySnapshot(raw, filePath, true);
  };

  /** Read-only twin of `mutate` for dry runs: same validation, nothing written, no lock taken. */
  const preview = async <T>(change: (file: ProjectRegistryFile) => T): Promise<T> => {
    const snapshot = await readFile();
    if (snapshot.identityMismatches.length > 0) {
      throw snapshot.identityMismatches[0]!.error;
    }
    return change(snapshot.file);
  };

  const mutate = async <T>(change: (file: ProjectRegistryFile) => T): Promise<T> => {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    return withFileLock(
      lockPath,
      async () => {
        const snapshot = await readFile();
        if (snapshot.identityMismatches.length > 0) {
          throw snapshot.identityMismatches[0]!.error;
        }
        const result = change(snapshot.file);
        await writeFileAtomic(filePath, `${JSON.stringify(snapshot.file, null, 2)}\n`);
        return result;
      },
      options.lock,
    );
  };

  /** Symlink/alias of a live folder: the id its canonical path would get, if it resolves. */
  const aliasId = async (ref: string): Promise<ProjectId | undefined> => {
    try {
      return deriveProjectId(await canonicalizeProjectPath(ref));
    } catch {
      return undefined;
    }
  };

  const find = (file: ProjectRegistryFile, ref: string, alias?: ProjectId): ProjectRecord | undefined => {
    const asPath = resolve(ref);
    return file.projects.find(
      (p) => p.id === ref || p.name === ref || p.path === asPath || (alias !== undefined && p.id === alias),
    );
  };

  const unknown = (ref: string): ProjectRegistryError =>
    new ProjectRegistryError({ code: 'KB_PROJECT_UNKNOWN', details: { path: ref } }, `No registered project matches "${ref}".`);

  const view = async (project: ProjectRecord): Promise<ProjectView> => {
    const exists = await pathExists(project.path);
    return {
      project,
      pathExists: exists,
      declaration: exists ? await hasDeclaration(project.path) : 'missing',
      stateDir: projectStateDir(root, project.id),
    };
  };

  return {
    root,
    filePath,

    async add(input: string, addOptions: AddProjectOptions = {}): Promise<AddProjectResult> {
      const canonical = await canonicalizeProjectPath(input);
      const requestedName = addOptions.name?.trim();
      if (requestedName !== undefined && !NAME_PATTERN.test(requestedName)) {
        throw new ProjectRegistryError({ code: 'KB_RUNTIME_INPUT_INVALID', details: { field: 'name' } }, `Invalid project name "${requestedName}": use letters, digits, ".", "_" or "-" (max 64, starting with a letter or digit).`);
      }
      const id = deriveProjectId(canonical);
      const apply = addOptions.dryRun ? preview : mutate;
      let alreadyExisted = false;
      const project = await apply((file) => {
        const existing = file.projects.find((p) => p.id === id);
        if (existing) {
          if (requestedName !== undefined && requestedName !== existing.name) {
            throw new ProjectRegistryError({ code: 'KB_PROJECT_ALREADY_REGISTERED', details: {
              path: canonical,
            } }, `Project already registered: ${canonical}`);
          }
          alreadyExisted = true;
          return existing;
        }
        const taken = new Set(file.projects.map((p) => p.name));
        if (requestedName !== undefined && taken.has(requestedName)) {
          throw new ProjectRegistryError({ code: 'KB_PROJECT_NAME_TAKEN', details: {
            name: requestedName,
          } }, `Project name "${requestedName}" is taken.`);
        }
        const record: ProjectRecord = {
          id,
          path: canonical,
          name: requestedName ?? uniqueName(basename(canonical), taken),
          status: 'active',
          addedAt: now().toISOString(),
          lastUsedAt: null,
        };
        file.projects.push(record);
        return record;
      });
      return { project, declaration: await hasDeclaration(canonical), alreadyExisted };
    },

    async list(): Promise<ProjectRegistryList> {
      const snapshot = await readFile();
      return {
        projects: await Promise.all(snapshot.file.projects.map(view)),
        diagnostics: snapshot.identityMismatches.map(({ record, error }) => {
          const envelope = projectErrorEnvelope(error);
          return {
            code: error.code,
            message: envelope.message,
            severity: 'warning',
            path: record.path,
            hint: envelope.hint,
          };
        }),
      };
    },

    async findContainingPath(cwd: string): Promise<ProjectView | undefined> {
      let canonicalCwd: string;
      try {
        canonicalCwd = await fs.realpath(cwd);
      } catch {
        canonicalCwd = resolve(cwd);
      }
      const snapshot = await readFile();
      const candidate = containingPath([
        ...snapshot.file.projects.map((record) => ({ path: record.path, record })),
        ...snapshot.identityMismatches.map((mismatch) => ({
          path: mismatch.record.path,
          record: mismatch.record,
          error: mismatch.error,
        })),
      ], canonicalCwd);
      if (!candidate) {return undefined;}
      if ('error' in candidate) {throw candidate.error;}
      return view(candidate.record);
    },

    async get(ref: string): Promise<ProjectView> {
      const snapshot = await readFile();
      const alias = await aliasId(ref);
      const record = find(snapshot.file, ref, alias);
      if (!record) {
        const resolvedRef = resolve(ref);
        const identityMismatch = snapshot.identityMismatches.find(({ record: invalid }) =>
          invalid.id === ref || invalid.name === ref || invalid.path === resolvedRef ||
          (alias !== undefined && invalid.id === alias));
        if (identityMismatch) {
          throw identityMismatch.error;
        }
        throw unknown(ref);
      }
      return view(record);
    },

    async remove(ref: string): Promise<ProjectRecord> {
      const alias = await aliasId(ref);
      return mutate((file) => {
        const record = find(file, ref, alias);
        if (!record) {
          throw unknown(ref);
        }
        file.projects = file.projects.filter((p) => p.id !== record.id);
        return record;
      });
    },

    async touch(ref: string): Promise<ProjectRecord> {
      const alias = await aliasId(ref);
      return mutate((file) => {
        const record = find(file, ref, alias);
        if (!record) {
          throw unknown(ref);
        }
        record.lastUsedAt = now().toISOString();
        return { ...record };
      });
    },

    stateDir(id: ProjectId): string {
      return projectStateDir(root, id);
    },
  };
}

/** Find the most specific registered project containing a working directory. */
export async function findProjectContainingPath(
  registry: IProjectRegistry,
  cwd: string,
): Promise<ProjectView | undefined> {
  return registry.findContainingPath(cwd);
}

/** Synchronous registry lookup for legacy synchronous plugin entry points. */
export function findRegisteredProjectContainingPathSync(
  cwd: string,
  options: ProjectRegistryOptions = {},
): ProjectRecord | undefined {
  const root = options.root ? resolve(options.root) : resolveKbHome(options.env);
  const filePath = join(root, PROJECT_REGISTRY_FILE);
  let snapshot: RegistrySnapshot;
  try {
    snapshot = parseRegistrySnapshot(readFileSync(filePath, 'utf8'), filePath, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  let canonicalCwd: string;
  try {
    canonicalCwd = realpathSync(cwd);
  } catch {
    canonicalCwd = resolve(cwd);
  }
  const candidate = containingPath([
    ...snapshot.file.projects,
    ...snapshot.identityMismatches.map(({ record, error }) => ({ ...record, error })),
  ], canonicalCwd);
  if (!candidate) {return undefined;}
  if ('error' in candidate) {throw candidate.error;}
  return candidate;
}
