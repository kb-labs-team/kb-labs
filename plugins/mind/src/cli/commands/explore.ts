import { defineCommand, handleError, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import type { CommandResult } from '@kb-labs/sdk';
import { ExploreRequestSchema, type ExploreFlags, type ExploreResponse } from '../../contracts/index.js';
import { buildMind } from '../../platform';

type ExploreResult = CommandResult<ExploreResponse>;

export default defineCommand<unknown, CLIInput<ExploreFlags>, ExploreResponse>({
  id: 'mind:explore',
  description: 'Task-orientation map — where to start and how involved a task looks',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<ExploreFlags>): Promise<ExploreResult> {
      const { flags } = input;
      const json = flags.format === 'json' || flags.json;
      try {
        const req = ExploreRequestSchema.parse({
          task: flags.task,
          indexId: flags.index,
          limit: flags.limit,
        });

        const mind = await buildMind(ctx.cwd);
        const res = await mind.explore(req);

        if (json) {
          return res;
        }
        if (res.files.length === 0) {
          ctx.ui?.warn?.(`No relevant files in index "${res.indexId}"`);
        } else {
          ctx.ui?.success?.(
            `${res.files.length} file(s) across ${res.meta.spread} dir(s) — confidence ${res.confidence.toFixed(2)}`,
            {
              sections: [
                ...(res.summary ? [{ header: 'Orientation', items: [res.summary] }] : []),
                {
                  header: `Index "${res.indexId}"`,
                  items: res.files.map((f) => {
                    const loc = `${f.file}:${f.lines[0]}-${f.lines[1]}`;
                    const tags = `[${f.matchedBy}${f.stale ? ', stale' : ''}]`;
                    return `${loc} ${tags}\n    ${f.why}`;
                  }),
                },
              ],
            },
          );
        }
        return res;
      } catch (err) {
        return handleError(err);
      }
    },
  },
});
