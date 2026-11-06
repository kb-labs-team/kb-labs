import type {
  CLIInput,
  ContextForHost,
  ExtractHostContext,
  PluginContextV3,
  ProjectEntry,
} from '../index.js';
import type { ErrorEnvelope, DetailsOptionFor, PlatformErrorCode } from '../errors/index.js';
import { createCatalogErrorEnvelope, getCatalogEntry } from '../errors/index.js';
import type {
  ManifestV3,
  PermissionSpec,
} from '../contracts/index.js';
import type {
  ILLM,
  MonitoringSnapshot,
} from '../types/index.js';

import {
  defineCommand,
  parseJsonc,
  defineManifest,
} from '../index.js';

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

type _RestHostCheck = Assert<
  Equals<ExtractHostContext<'rest'>['host'], 'rest'>
>;

type _ContextNarrowCheck = Assert<
  Equals<ContextForHost<'cli'>['hostContext']['host'], 'cli'>
>;

type _ProjectEntryIdIsPublic = Assert<Equals<ProjectEntry['id'], string>>;
const parsedJsonc: unknown = parseJsonc('{"value": true}');

const command = defineCommand<
  { profile: 'dev' | 'prod' },
  CLIInput<{ dryRun: boolean }>,
  { ok: boolean; id?: string }
>({
  id: 'type:test',
  handler: {
    execute: async (_ctx, input) => {
      const dryRun: boolean = input.flags.dryRun;
      return { ok: true, result: { ok: !dryRun } } as const;
    },
  },
});

const ctx = {} as PluginContextV3<{ profile: 'dev' | 'prod' }>;
void command.execute(ctx, { flags: { dryRun: true }, argv: [] });

// @ts-expect-error dryRun must be boolean
void command.execute(ctx, { flags: { dryRun: 'yes' }, argv: [] });

const manifest = defineManifest({
  schema: 'kb.plugin/3',
  id: '@kb-labs/type-test',
  version: '1.0.0',
});

const m: ManifestV3 = manifest;
void m;

const permissions: PermissionSpec = {
  network: { fetch: [] },
  platform: { llm: true },
};
void permissions;

const llm = {} as ILLM;
void llm;

const monitoring = {} as MonitoringSnapshot;
void monitoring;

const code: PlatformErrorCode = 'KB_CONFIG_INVALID';
const entry = getCatalogEntry(code);
const details: DetailsOptionFor<typeof code> = { details: { path: 'config.json' } };
const error: ErrorEnvelope = createCatalogErrorEnvelope({ code, ...details });
void entry;
void error;

export {};
