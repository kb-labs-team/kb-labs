import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import {
  defineCommand,
  validationError,
  handleError,
  type CommandResult,
  type PluginContextV3,
  type CLIInput,
} from '@kb-labs/sdk';
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
import { formatCommandHelp } from '@kb-labs/shared-cli-ui';
import { CredentialsManager, SessionManager } from '@kb-labs/cli-runtime/gateway';
import { findProjectConfigRoot } from '@kb-labs/core-workspace';
import type { GatewayCredentials, SessionCredentials } from '@kb-labs/cli-runtime/gateway';

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
  ctx: PluginContextV3,
  rawInput: CLIInput<ScaffoldFlags>,
): Promise<CommandResult<ScaffoldResult>> {
  const start = Date.now();
  const input = { ...rawInput.flags, argv: rawInput.argv };

  const { entity: entityArg, name: nameArg } = parsePositional(input.argv);

  const available = await listEntities(TEMPLATES_ROOT);
  if (available.length === 0) {
    validationError(ctx, 'No scaffold templates found. Reinstall @kb-labs/scaffold.');
    return { ok: false, error: 'No scaffold templates found' };
  }

  if (!entityArg) {
    ctx.ui?.write?.(formatCommandHelp({
      title: 'kb scaffold run',
      description: 'Scaffold a new plugin, adapter, or other entity from a template.',
      examples: available.map((e) => `kb scaffold run ${e} my-${e}`),
      flags: SCAFFOLD_FLAGS,
    }) + '\n');
    ctx.ui?.info?.(`Available entities: ${available.join(', ')}`);
    return { ok: false, error: `Unknown entity "${entityArg}"` };
  }

  if (!available.includes(entityArg)) {
    validationError(ctx, `Unknown entity "${entityArg}". Available: ${available.join(', ')}`);
    return { ok: false, error: 'An entity name is required' };
  }

  if (!nameArg) {
    ctx.ui?.write?.(formatCommandHelp({
      title: `kb scaffold run ${entityArg} <name>`,
      description: `Scaffold a new ${entityArg}. Provide a name to continue.`,
      examples: [`kb scaffold run ${entityArg} my-${entityArg}`],
      flags: SCAFFOLD_FLAGS,
    }) + '\n');
    return { ok: false, error: 'An entity name is required' };
  }

  const problem = runValidator('npmName', nameArg);
  if (problem) {
    validationError(ctx, `Invalid name "${nameArg}": ${problem}`, 'Name must be lowercase, no spaces, valid npm package name.');
    return { ok: false, error: `Invalid name "${nameArg}": ${problem}` };
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
    handleError(ctx, e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
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
    return { ok: true, result: { outRoot, files: result.files.length } };
  }

  if (state.exists && !state.empty) {
    if (input.force) {
      ctx.ui?.warn?.(`--force: overwriting ${outRoot}`);
    } else {
      validationError(ctx, `Output directory "${outRoot}" already exists and is not empty.`, 'Use --force to overwrite.');
      return { ok: false, error: `Output directory "${outRoot}" already exists and is not empty` };
    }
  }

  await writeFiles({ outRoot, files: result.files, force: input.force });

  const entryPkgDir =
    entityArg === 'plugin'
      ? `${outRoot}/packages/${nameArg}-entry`
      : outRoot;

  await linkWithMarketplace(entryPkgDir, ctx.cwd, result.manifest);

  const registrationNote = 'Registered in .kb/marketplace.lock';

  const timing = Date.now() - start;

  ctx.ui?.success?.(`Scaffolded ${entityArg} "${nameArg}"`, {
    title: 'scaffold run',
    sections: [
      {
        header: 'Output',
        items: [outRoot],
      },
      {
        header: 'Marketplace',
        items: [registrationNote],
      },
      {
        header: 'Next steps',
        items: [
          `cd ${outRoot}`,
          'pnpm install',
          'pnpm -w build',
          `pnpm kb ${nameArg} hello   # try it`,
          `pnpm kb scaffold doctor --path ${dirname(outRoot)}`,
        ],
      },
    ],
    timing,
  });

  return { ok: true, result: { outRoot, files: result.files.length } };
}

type MarketplaceCredentials = GatewayCredentials | SessionCredentials;
type MarketplaceAuth = {
  credentials: MarketplaceCredentials;
  refresh: () => Promise<MarketplaceAuth>;
};

function createMarketplaceAuth(
  credentials: MarketplaceCredentials,
  refresh: (credentials: MarketplaceCredentials) => Promise<MarketplaceCredentials>,
): MarketplaceAuth {
  return {
    credentials,
    refresh: async () => createMarketplaceAuth(await refresh(credentials), refresh),
  };
}

async function loadMarketplaceCredentials(): Promise<MarketplaceAuth | null> {
	try {
		const sessions = new SessionManager();
		const session = await sessions.load();
		if (session) {
			const current = sessions.isExpired(session) ? await sessions.refresh(session) : session;
			return createMarketplaceAuth(current, (value) => sessions.refresh(value as SessionCredentials));
		}
		const manager = new CredentialsManager();
		const credentials = await manager.load();
		if (!credentials) {
			return null;
		}
		const current = manager.isExpired(credentials) ? await manager.refresh(credentials) : credentials;
		return createMarketplaceAuth(current, (value) => manager.refresh(value as GatewayCredentials));
	} catch {
		// Local marketplace linking is allowed without a user session. A stale
		// credential must not turn a completed local scaffold into a failure;
		// protected endpoints still reject the subsequent link request explicitly.
		return null;
	}
}

/** Register through the canonical marketplace API; the daemon owns lock format and integrity. */
async function linkWithMarketplace(entryPkgDir: string, cwd: string, manifest: Record<string, unknown>): Promise<void> {
  const projectRoot = await findProjectConfigRoot(cwd);
  if (!projectRoot) {
    throw new Error(`Cannot register scaffolded plugin: no project config found from ${cwd}`);
  }

  let auth = await loadMarketplaceCredentials();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const marketplaceUrl = process.env.KB_MARKETPLACE_URL;
    const gatewayUrl = auth?.credentials.gatewayUrl ?? process.env.KB_GATEWAY_URL ?? 'http://127.0.0.1:4000';
    const endpoint = marketplaceUrl
      ? `${marketplaceUrl.replace(/\/+$/, '')}/api/v1/marketplace/packages/link`
      : `${gatewayUrl.replace(/\/+$/, '')}/api/v1/marketplace/packages/link`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(auth ? { Authorization: `Bearer ${auth.credentials.accessToken}` } : {}),
      },
      body: JSON.stringify({ path: resolve(entryPkgDir), scope: 'project', projectRoot, manifest }),
    });
    if (response.status === 401 && auth && attempt === 0) {
      auth = await auth.refresh();
      continue;
    }
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Marketplace registration failed (${response.status}): ${detail}`);
    }
    return;
  }
  throw new Error('Marketplace registration failed after refreshing authentication');
}

export default defineCommand({
  id: 'scaffold:run',
  description: 'Scaffold <entity> <name> from blocks',

  handler: {
    execute: runDefault,
  },
});
