import { parseViewerInput } from '../validation.js';
import { viewerIndexQuerySchema } from '../schemas.js';
import { defineHandler, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { loadArchitecture, resolveSourceRoot, listFiles } from '../../core/index.js';

export default defineHandler({
  async execute(ctx: PluginContextV3, input: RestInput<{ path?: string; source?: string }>) {
    const query = parseViewerInput(viewerIndexQuerySchema, input.query ?? {});
    const root = await resolveSourceRoot(ctx.cwd, query.source);
    const architecture = await loadArchitecture(root);
    const files = await listFiles(root, query.path ?? '');
    return { architecture, files };
  },
});
