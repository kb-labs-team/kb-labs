import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  BlockDefinition,
  EntityDefinition,
  Variable,
} from '@kb-labs/scaffold-contracts';

interface RawBlockYaml {
  id?: string;
  describe?: string;
  requires?: string[];
  conflicts?: string[];
  variables?: Variable[];
  manifestPatch?: string;
  snippets?: string;
}

interface RawEntityYaml {
  id?: string;
  displayName?: string;
  description?: string;
  variables?: Variable[];
  defaults?: { blocks?: string[] };
  output?: string;
  manifestTarget?: string;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function loadBlock(blockDir: string): Promise<BlockDefinition> {
  const blockYamlPath = join(blockDir, 'block.yaml');
  const raw = await readFile(blockYamlPath, 'utf8');
  const parsed = parseYaml(raw) as RawBlockYaml;

  if (!parsed.id) {
    throw new Error(`block.yaml at ${blockYamlPath} is missing "id"`);
  }

  const filesDir = join(blockDir, 'files');
  const manifestPatchFile =
    parsed.manifestPatch ?? 'manifest.patch.yaml';
  const snippetsFile = parsed.snippets ?? 'manifest.snippets.yaml';

  const manifestPatchPath = join(blockDir, manifestPatchFile);
  const snippetsPath = join(blockDir, snippetsFile);

  const [hasFiles, hasPatch, hasSnippets] = await Promise.all([
    pathExists(filesDir),
    pathExists(manifestPatchPath),
    pathExists(snippetsPath),
  ]);

  return {
    id: parsed.id,
    describe: parsed.describe ?? parsed.id,
    requires: parsed.requires,
    conflicts: parsed.conflicts,
    variables: parsed.variables,
    filesDir: hasFiles ? filesDir : blockDir,
    manifestPatch: hasPatch ? manifestPatchPath : undefined,
    snippetsPath: hasSnippets ? snippetsPath : undefined,
  };
}

/**
 * Load an entity definition from a templates directory.
 *
 * @param templatesRoot directory containing `<entity>/entity.yaml` and `<entity>/blocks/*`
 * @param entityId e.g. 'plugin', 'adapter'
 */
export async function loadEntity(
  templatesRoot: string,
  entityId: string,
): Promise<EntityDefinition> {
  const entityDir = resolve(templatesRoot, entityId);
  const entityYamlPath = join(entityDir, 'entity.yaml');

  if (!(await pathExists(entityYamlPath))) {
    throw new Error(
      `Entity "${entityId}" not found: ${entityYamlPath} does not exist`,
    );
  }

  const raw = await readFile(entityYamlPath, 'utf8');
  const parsed = (parseYaml(raw) ?? {}) as RawEntityYaml;

  const id = parsed.id ?? entityId;
  const blocksDir = join(entityDir, 'blocks');
  const blocks: BlockDefinition[] = [];

  if (await pathExists(blocksDir)) {
    const entries = await readdir(blocksDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {continue;}
      const blockDir = join(blocksDir, entry.name);
      if (!(await pathExists(join(blockDir, 'block.yaml')))) {continue;}
      blocks.push(await loadBlock(blockDir));
    }
  }

  return {
    id,
    displayName: parsed.displayName ?? id,
    description: parsed.description,
    variables: parsed.variables ?? [],
    blocks,
    defaults: parsed.defaults,
    output: parsed.output,
    manifestTarget: parsed.manifestTarget,
  };
}

/**
 * List entity ids available in the templates root (directories with `entity.yaml`).
 */
export async function listEntities(templatesRoot: string): Promise<string[]> {
  if (!(await pathExists(templatesRoot))) {return [];}
  const entries = await readdir(templatesRoot, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {continue;}
    if (await pathExists(join(templatesRoot, entry.name, 'entity.yaml'))) {
      result.push(entry.name);
    }
  }
  return result.sort();
}
