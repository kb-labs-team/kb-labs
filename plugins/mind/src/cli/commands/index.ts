import { defineCommand, handleError, useLoader, type CLIInput, type PluginCommandContextV3 } from '@kb-labs/sdk';
import type { CommandResult } from '@kb-labs/sdk';
import { type IndexFlags, type IndexResponse } from '../../contracts/index.js';
import { type IngestProgress } from '../../core/index.js';
import { buildMind } from '../../platform';

type IndexCmdResult = CommandResult<IndexResponse>;

/** Map an ingest stage to a one-line loader label. */
function stageText(e: IngestProgress): string {
  switch (e.stage) {
    case 'discover':
      return `Discovered ${e.files} file(s)`;
    case 'delta':
      return `Delta: ${e.toIndex} to (re)index · ${e.unchanged} unchanged · ${e.removed} removed`;
    case 'chunk':
      return `Chunked → ${e.chunks} chunk(s)`;
    case 'embed':
      return `Embedding ${e.done}/${e.total} chunk(s)`;
    case 'upsert':
      return `Upserting ${e.count} vector(s)`;
    case 'save':
      return 'Saving index manifest';
  }
}

export default defineCommand<unknown, CLIInput<IndexFlags>, IndexResponse>({
  id: 'mind:index',
  description: 'Build or refresh a Mind index from source files',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<IndexFlags>): Promise<IndexCmdResult> {
      const { flags } = input;
      try {
        // `--root` lets one kb-labs install index an arbitrary project root
        // (paths + freshness resolve against it); defaults to the invocation cwd.
        const mind = await buildMind(flags.root ?? ctx.cwd);

        // Built-in SDK loader: an animated spinner whose text we drive per stage
        // (writes to stdout directly, so it renders even though the CLI presenter
        // has no spinner). It self-suppresses in JSON mode, keeping stdout clean.
        const loader = flags.json ? undefined : useLoader(`Indexing "${flags.index ?? 'default'}"…`);
        loader?.start();

        const res = await mind.index(
          { indexId: flags.index, scope: flags.scope, full: flags.full },
          flags.json ? undefined : (e) => loader?.update({ text: stageText(e) }),
        );

        if (flags.json) {
          return res;
        }
        const summary = `Indexed ${res.filesIndexed} file(s), ${res.chunks} chunk(s) into "${res.indexId}" (${res.durationMs}ms)`;
        if (loader) {
          loader.succeed(summary);
        } else {
          ctx.ui?.success?.(summary);
        }
        return res;
      } catch (err) {
        return handleError(err);
      }
    },
  },
});
