import { describe, expect, expectTypeOf, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setUserConfigValue } from '@kb-labs/core-config';
import {
  ExecutionConfigSchema as PublicExecutionConfigSchema,
  PlatformUserConfigSchema,
  validatePlatformUserConfig,
} from '@kb-labs/core-runtime';
import type { HealthStatus as SharedHealthStatus, ResolvedExecutionMode } from '@kb-labs/core-contracts';
import type { ExecutionMetadata } from '@kb-labs/core-platform';
import type { BackendOptions, ExecutionBackend } from '@kb-labs/plugin-execution-factory';
import type { ExecutionConfig } from '../config.js';
import type { z } from 'zod';
import { RESOLVED_EXECUTION_MODES } from '@kb-labs/core-contracts';

describe('resolved execution mode contract', () => {
  it('keeps remote out of public mode, health, result and config types', () => {
    expectTypeOf<'remote'>('remote').not.toMatchTypeOf<ResolvedExecutionMode>();
    expectTypeOf<ExecutionBackend['executionMode']>(undefined as never).toEqualTypeOf<ResolvedExecutionMode>();
    expectTypeOf<SharedHealthStatus['backend']>(undefined as never).toEqualTypeOf<ResolvedExecutionMode>();
    expectTypeOf<ExecutionMetadata['backend']>(undefined as never).toEqualTypeOf<ResolvedExecutionMode | undefined>();
    expectTypeOf<ExecutionConfig['mode']>(undefined as never).toEqualTypeOf<'auto' | ResolvedExecutionMode | undefined>();
    expectTypeOf<z.input<typeof PublicExecutionConfigSchema>['mode']>(undefined as never)
      .toEqualTypeOf<'auto' | ResolvedExecutionMode | undefined>();
    expectTypeOf<BackendOptions['mode']>(undefined as never).toEqualTypeOf<'auto' | Exclude<ResolvedExecutionMode, 'container'> | undefined>();

    // @ts-expect-error the exported schema input cannot express roadmap-only remote
    const remoteSchemaInput: z.input<typeof PublicExecutionConfigSchema> = { mode: 'remote' };
    void remoteSchemaInput;

    // @ts-expect-error remote settings are not part of the public runtime config
    const remoteConfig: ExecutionConfig = { remote: { endpoint: 'http://executor.test' } };
    void remoteConfig;
  });

  it('refuses roadmap and unknown modes with the supported-mode hint', () => {
    const hint = `Supported modes are auto, ${RESOLVED_EXECUTION_MODES.join(', ')}. Run \`kb config set platform.execution.mode in-process --scope platform\`.`;

    for (const mode of ['remote', 'turbo']) {
      const result = PublicExecutionConfigSchema.safeParse({ mode });
      expect(result.success).toBe(false);
      if (result.success) continue;
      const issue = result.error.issues[0];
      if (issue?.code !== 'invalid_value') {
        throw new Error(`Expected invalid_value, received ${issue?.code ?? 'no issue'}`);
      }
      expect(issue.values).toEqual(['auto', ...RESOLVED_EXECUTION_MODES]);

      const platformIssues = validatePlatformUserConfig({ platform: { execution: { mode } } });
      expect(platformIssues[0]?.path).toBe('platform.execution.mode');
      if (mode === 'remote') {
        expect(platformIssues[0]?.hint).toBe(hint);
      } else {
        expect(platformIssues[0]?.hint).toBeUndefined();
        expect(issue.message).toContain(RESOLVED_EXECUTION_MODES[0]);
      }
    }
  });

  it('does not persist remote and preserves the existing config hint', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'kb-execution-mode-config-'));
    const filePath = path.join(tempRoot, 'kb.config.jsonc');
    const original = '{"platform":{"execution":{"mode":"in-process"}}}\n';
    const hint = `Supported modes are auto, ${RESOLVED_EXECUTION_MODES.join(', ')}. Run \`kb config set platform.execution.mode in-process --scope platform\`.`;

    try {
      await writeFile(filePath, original, 'utf8');
      await expect(setUserConfigValue({
        filePath,
        path: ['platform', 'execution', 'mode'],
        value: 'remote',
        schema: PlatformUserConfigSchema,
      })).rejects.toMatchObject({
        code: 'KB_CONFIG_INVALID',
        details: { path: 'platform.execution.mode' },
        metadata: { hint },
      });
      expect(await readFile(filePath, 'utf8')).toBe(original);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
