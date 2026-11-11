import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { defineSystemCommand, type SystemCommandContext } from '@kb-labs/shared-command-kit';
import { validationError, handleError, type CommandResult } from '@kb-labs/sdk';
import {
  build,
  inspectTarget,
  formatTree,
  listEntities,
  loadEntity,
  resolveBlocks,
  runValidator,
  writeFiles,
} from '@kb-labs/scaffold-core';
import type {
  RenderContext,
} from '@kb-labs/scaffold-contracts';
import { writeScaffoldTransaction } from './scaffold-transaction.js';

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_ROOT = resolve(here, '..', '..', 'templates');

const SCAFFOLD_FLAGS = [
  { name: 'scope', description: 'npm scope, e.g. @my-org' },
  { name: 'blocks', description: 'comma-separated block ids to include' },
  { name: 'out', description: 'custom output directory' },
  { name: 'force', description: 'overwrite existing output directory' },
  { name: 'dry-run', description: 'preview files without writing' },
];

interface ScaffoldFlags {
  blocks?: string;
  force?: boolean;
  'dry-run'?: boolean;
  out?: string;
  scope?: string;
  mode?: string;
}

type ScaffoldResult = { outRoot: string; files: number };

async function readVersion(pkgPath: string): Promise<string> {
  try {
    const raw = await readFile(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const FALLBACK_VERSIONS = {
  sdk: '2.18.0',
  devkit: '2.28.0',
  commandKit: '2.30.0',
} as const;

const GENERATED_WORKSPACE_BUILD_POLICY = `

# Required native builds for the generated plugin toolchain.
strictDepBuilds: false
allowBuilds:
  '@kb-labs/devkit': true
  '@parcel/watcher': true
  '@swc/core': true
  better-sqlite3: true
  esbuild: true
  unrs-resolver: true
`;

function ensureWorkspaceBuildPolicyInFiles(files: Array<{ path: string; contents: string }>): void {
  const workspace = files.find((file) => file.path === 'pnpm-workspace.yaml');
  if (workspace && !workspace.contents.includes('\nallowBuilds:')) {
    workspace.contents += GENERATED_WORKSPACE_BUILD_POLICY;
  }
}

async function detectVersions(): Promise<Record<string, string>> {
  const req = createRequire(import.meta.url);
  const readPkg = async (spec: string, fallback: string): Promise<string> => {
    try {
      const resolved = req.resolve(spec);
      const v = await readVersion(resolved);
      return v === '0.0.0' ? fallback : v;
    } catch {
      return fallback;
    }
  };
  const [sdk, devkit, commandKit] = await Promise.all([
    readPkg('@kb-labs/sdk/package.json', FALLBACK_VERSIONS.sdk),
    readPkg('@kb-labs/devkit/package.json', FALLBACK_VERSIONS.devkit),
    readPkg('@kb-labs/shared-command-kit/package.json', FALLBACK_VERSIONS.commandKit),
  ]);
  // Release smoke tests install the candidate packages under a dist-tag. A
  // caret range would resolve the previous stable package instead, so carry
  // the channel through to generated manifests as a valid npm spec.
  const smokeTag = process.env.KB_CREATE_PACKAGE_TAG;
  return {
    sdk,
    devkit,
    commandKit,
    ...(smokeTag
      ? {
          sdkSpec: smokeTag,
          devkitSpec: smokeTag,
          commandKitSpec: smokeTag,
        }
      : {}),
  };
}

function parsePositional(argv: string[] | undefined): {
  entity?: string;
  name?: string;
} {
  if (!argv || argv.length === 0) { return {}; }
  const positional = argv.filter((a) => !a.startsWith('-'));
  return { entity: positional[0], name: positional[1] };
}

async function runDefault(
  ctx: SystemCommandContext,
  argv: string[],
  flags: ScaffoldFlags,
): Promise<CommandResult<ScaffoldResult>> {
  const start = Date.now();
  const input = { ...flags, argv };

  const { entity: entityArg, name: nameArg } = parsePositional(input.argv);

  const available = await listEntities(TEMPLATES_ROOT);
  if (available.length === 0) {
    return validationError(
      'No scaffold templates were found in the platform package.',
      'Run `kb-create update` to restore platform packages, then retry `kb scaffold run <entity> <name>`.',
    );
  }

  if (!entityArg) {
    return { ok: false, error: { code: 'KB_RUNTIME_INPUT_INVALID', message: 'An entity type is required.', hint: 'Run `kb scaffold run --help` to list entity types, then rerun `kb scaffold run <entity> <name>`.' } };
  }

  if (!available.includes(entityArg)) {
    return validationError(`Unknown entity "${entityArg}". Available: ${available.join(', ')}`);
  }

  if (!nameArg) {
    return { ok: false, error: { code: 'KB_RUNTIME_INPUT_INVALID', message: 'An entity name is required.', hint: 'Provide an entity and name, for example `kb scaffold run plugin my-plugin`.' } };
  }

  const problem = runValidator('npmName', nameArg);
  if (problem) {
    return validationError(`Invalid name "${nameArg}": ${problem}`, 'Name must be lowercase, no spaces, valid npm package name.');
  }

  const entity = await loadEntity(TEMPLATES_ROOT, entityArg);

  const vars: Record<string, unknown> = {};
  for (const v of entity.variables) {
    if (v.name === 'scope' && input.scope !== undefined) {
      vars[v.name] = input.scope;
    } else if (v.name === 'mode' && input.mode !== undefined) {
      vars[v.name] = input.mode;
    } else {
      vars[v.name] = v.default ?? '';
    }
  }

  let selectedBlocks: string[];
  if (input.blocks) {
    selectedBlocks = input.blocks
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  } else {
    selectedBlocks = entity.defaults?.blocks ?? entity.blocks.map((b) => b.id);
  }

  try {
    resolveBlocks(entity.blocks, selectedBlocks);
  } catch (e) {
    return handleError(e);
  }

  for (const blockId of selectedBlocks) {
    const block = entity.blocks.find((b) => b.id === blockId);
    for (const v of block?.variables ?? []) {
      vars[v.name] = v.default ?? '';
    }
  }

  const scope = (vars.scope as string) ?? input.scope ?? '';
  const mode = (input.mode ?? (vars.mode as string) ?? 'in-workspace') as
    | 'in-workspace'
    | 'standalone';

  const versions = await detectVersions();

  const context: RenderContext = {
    name: nameArg,
    scope,
    vars,
    blocks: selectedBlocks,
    mode,
    versions,
  };

  const result = await build({
    entity,
    selectedBlockIds: selectedBlocks,
    context,
  });

  if (entityArg === 'plugin') {
    ensureWorkspaceBuildPolicyInFiles(result.files);
  }

  const outRoot = input.out ?? result.outRoot;
  const state = await inspectTarget(outRoot);

  if (input['dry-run']) {
    ctx.ui?.success?.('Dry run complete', {
      title: 'scaffold run — dry run',
      sections: [
        { header: 'Would write to', items: [outRoot] },
        { header: 'Files', items: formatTree(result.files).split('\n').filter(Boolean) },
      ],
    });
    return { outRoot, files: result.files.length };
  }

  if (state.exists && !state.empty) {
    if (input.force) {
      ctx.ui?.warn?.(`--force: overwriting ${outRoot}`);
    } else {
      return validationError(`Output directory "${outRoot}" already exists and is not empty.`, 'Use --force to overwrite.');
    }
  }

  try {
    await writeScaffoldTransaction(
      outRoot,
      () => writeFiles({ outRoot, files: result.files, force: input.force }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return validationError(message, 'Check the platform with `kb-create status`, then start it with `kb-create start`.');
  }

  const linkPath = relative(ctx.cwd, entityArg === 'plugin'
    ? resolve(outRoot, 'packages', `${nameArg}-entry`)
    : outRoot);

  const timing = Date.now() - start;

  ctx.ui?.success?.(`Scaffolded ${entityArg} "${nameArg}"`, {
    title: 'scaffold run',
    sections: [
      {
        header: 'Output',
        items: [outRoot],
      },
      {
        header: 'Next steps',
        items: entityArg === 'plugin' ? [
          `cd ${outRoot}`,
          'pnpm install',
          'pnpm -w build',
          `kb marketplace plugins add --link ${linkPath}`,
          `kb ${nameArg} hello`,
          `pnpm kb scaffold doctor --path ${dirname(outRoot)}`,
        ] : [
          `cd ${outRoot}`,
          'pnpm install',
          'pnpm -w build',
          `kb marketplace plugins add --scope platform --link ${linkPath}`,
          `kb adapter bind <slot> ${scope ? `${scope}/` : ''}${nameArg}`,
        ],
      },
    ],
    timing,
  });

  return { outRoot, files: result.files.length };
}

export const scaffoldRun = defineSystemCommand({
  name: 'run',
  scope: 'project',
  jsonTest: { noSafeValidPath: 'Scaffold writes generated files into the selected output directory.' },
  description: 'Scaffold <entity> <name> from blocks',
  category: 'scaffold',
  flags: {
    blocks: { type: 'string', description: 'Comma-separated block ids to include' },
    yes: { type: 'boolean', description: 'Accept defaults and skip prompts' },
    force: { type: 'boolean', description: 'Overwrite non-empty target directory' },
    'dry-run': { type: 'boolean', description: 'Print the tree that would be written and exit' },
    out: { type: 'string', description: 'Override the output directory' },
    scope: { type: 'string', description: 'npm scope for the generated package' },
    mode: {
      type: 'string',
      description: 'Layout mode: "in-workspace" (workspace:* deps) or "standalone" (semver deps + pnpm-workspace.yaml)',
    },
  },
  examples: [
    'kb scaffold run plugin my-plugin',
    'kb scaffold run adapter my-llm --blocks base',
    'kb scaffold run plugin ui --scope @acme --yes',
    'kb scaffold run plugin demo --dry-run',
  ],
  async handler(ctx, argv, flags) {
    return runDefault(ctx, argv, flags);
  },
});
