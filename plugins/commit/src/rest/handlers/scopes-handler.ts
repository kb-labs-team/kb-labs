import { defineHandler, useConfig, type PluginContextV3, type SelectData, rethrowForRest } from '@kb-labs/sdk';
import { type CommitPluginConfig, resolveCommitConfig } from '../../contracts/index.js';

/**
 * GET /scopes handler
 *
 * Returns available scopes from kb.config.json (plugins.commit.scope.scopes).
 * Falls back to a single "root" scope if not configured.
 */
export default defineHandler({
  async execute(_ctx: PluginContextV3, _input: unknown): Promise<SelectData> {
    try {
      const fileConfig = await useConfig<Partial<CommitPluginConfig>>();
      const config = resolveCommitConfig(fileConfig ?? {});

      const scopes = config.scope?.scopes ?? [{ id: 'root', label: 'root', path: '.' }];
      const defaultId = config.scope?.default ?? scopes[0]?.id ?? 'root';

      return {
        value: defaultId,
        options: scopes.map((s) => ({
          value: s.id,
          label: s.label,
          description: s.description,
        })),
      };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
