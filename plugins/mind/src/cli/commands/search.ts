import { defineCommand, handleError, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import type { CommandResult } from '@kb-labs/sdk';
import { SearchRequestSchema, type SearchFlags, type SearchResponse } from '../../contracts/index.js';
import { buildMind } from '../../platform';

type SearchResult = CommandResult<SearchResponse>;

export default defineCommand<unknown, CLIInput<SearchFlags>, SearchResponse>({
  id: 'mind:search',
  description: 'Locate sources — fast retrieval over a Mind index (no LLM)',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<SearchFlags>): Promise<SearchResult> {
      const { flags } = input;
      const json = flags.format === 'json' || flags.json;
      try {
        // Validate/normalize CLI flags into the wire request (narrows enums).
        const req = SearchRequestSchema.parse({
          text: flags.text,
          indexId: flags.index,
          intent: flags.intent,
          limit: flags.limit,
          snippet: flags.snippet,
        });

        const mind = await buildMind(ctx.cwd);
        const res = await mind.search(req);

        if (json) {
          return res;
        }
        if (res.results.length === 0) {
          ctx.ui?.warn?.(`No results in index "${res.indexId}"`);
        } else {
          ctx.ui?.success?.(`${res.results.length} result(s) — confidence ${res.confidence.toFixed(2)}`, {
            sections: [
              {
                header: `Index "${res.indexId}"`,
                items: res.results.map((r) => {
                  const loc = `${r.file}:${r.lines[0]}-${r.lines[1]}`;
                  const tags = `[${r.matchedBy}${r.stale ? ', stale' : ''}]`;
                  return r.snippet ? `${loc} ${tags}\n    ${r.snippet}` : `${loc} ${tags}`;
                }),
              },
            ],
          });
        }
        return res;
      } catch (err) {
        return handleError(err);
      }
    },
  },
});
