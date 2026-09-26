import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type {
  AddProjectOptions,
  AddProjectResult,
  IProjectRegistry,
  ProjectDeclarationState,
  ProjectId,
  ProjectRecord,
  ProjectRegistryFile,
  ProjectStatus,
  ProjectView,
} from '@kb-labs/core-contracts';
import { ProjectRegistryError } from './errors.js';
import { withFileLock, type FileLockOptions } from './file-lock.js';
import { canonicalizeProjectPath, deriveProjectId, isProjectId } from './project-id.js';

export const PROJECT_REGISTRY_SCHEMA_VERSION = 1;
export const PROJECT_REGISTRY_FILE = 'projects.json';

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const STATUSES: readonly ProjectStatus[] = ['active', 'disabled'];

/** Root of machine-level state: `$KB_HOME` when set, otherwise `~/.kb`. */
export function resolveKbHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.KB_HOME?.trim();
  return resolve(override ? override : join(homedir(), '.kb'));
}

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

function corrupt(file: string, reason: string): ProjectRegistryError {
  return new ProjectRegistryError('KB_PROJECT_REGISTRY_CORRUPT', `Project registry ${file} is invalid: ${reason}`, {
    file,
    reason,
  });
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
    throw corrupt(file, `${at}.id does not match its path`);
  }
  return { id, path, name, status: status as ProjectStatus, addedAt, lastUsedAt };
}

/** Validates the raw file content. Never repairs: a bad file is reported, not rewritten. */
export function parseRegistryFile(raw: string, file: string): ProjectRegistryFile {
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
    throw new ProjectRegistryError(
      'KB_PROJECT_REGISTRY_SCHEMA_UNSUPPORTED',
      `Project registry ${file} has schemaVersion ${schemaVersion}; this build supports ${PROJECT_REGISTRY_SCHEMA_VERSION}.`,
      { file, found: String(schemaVersion), supported: String(PROJECT_REGISTRY_SCHEMA_VERSION) },
    );
  }
  if (!Array.isArray(projects)) {
    throw corrupt(file, 'projects is not an array');
  }
  const records = projects.map((entry, index) => parseRecord(entry, file, index));
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
  return { schemaVersion, projects: records };
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

export function createProjectRegistry(options: ProjectRegistryOptions = {}): IProjectRegistry {
  const root = options.root ? resolve(options.root) : resolveKbHome(options.env);
  const filePath = join(root, PROJECT_REGISTRY_FILE);
  const lockPath = `${filePath}.lock`;
  const now = options.now ?? (() => new Date());

  const readFile = async (): Promise<ProjectRegistryFile> => {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: PROJECT_REGISTRY_SCHEMA_VERSION, projects: [] };
      }
      throw error;
    }
    return parseRegistryFile(raw, filePath);
  };

  /** Read-only twin of `mutate` for dry runs: same validation, nothing written, no lock taken. */
  const preview = async <T>(change: (file: ProjectRegistryFile) => T): Promise<T> => change(await readFile());

  const mutate = async <T>(change: (file: ProjectRegistryFile) => T): Promise<T> => {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    return withFileLock(
      lockPath,
      async () => {
        const file = await readFile();
        const result = change(file);
        await writeFileAtomic(filePath, `${JSON.stringify(file, null, 2)}\n`);
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
    new ProjectRegistryError('KB_PROJECT_UNKNOWN', `No registered project matches "${ref}".`, { path: ref });

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
        throw new ProjectRegistryError(
          'KB_RUNTIME_INPUT_INVALID',
          `Invalid project name "${requestedName}": use letters, digits, ".", "_" or "-" (max 64, starting with a letter or digit).`,
          { name: requestedName },
        );
      }
      const id = deriveProjectId(canonical);
      const apply = addOptions.dryRun ? preview : mutate;
      const project = await apply((file) => {
        if (file.projects.some((p) => p.id === id)) {
          throw new ProjectRegistryError('KB_PROJECT_ALREADY_REGISTERED', `Project already registered: ${canonical}`, {
            path: canonical,
          });
        }
        const taken = new Set(file.projects.map((p) => p.name));
        if (requestedName !== undefined && taken.has(requestedName)) {
          throw new ProjectRegistryError('KB_PROJECT_NAME_TAKEN', `Project name "${requestedName}" is taken.`, {
            name: requestedName,
          });
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
      return { project, declaration: await hasDeclaration(canonical) };
    },

    async list(): Promise<ProjectView[]> {
      const file = await readFile();
      return Promise.all(file.projects.map(view));
    },

    async get(ref: string): Promise<ProjectView> {
      const file = await readFile();
      const record = find(file, ref, await aliasId(ref));
      if (!record) {
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
