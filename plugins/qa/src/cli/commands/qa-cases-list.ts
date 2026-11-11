import { defineCommand, useConfig, type CLIInput, type CommandResult, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { parseQACatalog } from '../../core/index.js';
import type { QAPluginConfig } from '../../contracts/index.js';
import type { QaCasesListFlags } from './flags.js';
import { resolveCatalogPath } from './qa-cases-utils.js';

export default defineCommand<unknown, CLIInput<QaCasesListFlags>, unknown>({
  id: 'qa:cases:list',
  description: 'List cases in the QA catalog',
  handler: { async execute(ctx: PluginCommandContextV3, input: CLIInput<QaCasesListFlags>): Promise<CommandResult> {
    const config = await useConfig<QAPluginConfig>();
    const catalog = parseQACatalog(resolveCatalogPath(ctx.cwd ?? process.cwd(), config?.casesPath));
    const result = { schema: 'kb.qa-case-list/v1', cases: catalog.cases, diagnostics: catalog.diagnostics };
    if (catalog.diagnostics.length) {
      if (!input.flags.json) ctx.ui?.warn?.(`QA case catalog contains ${catalog.diagnostics.length} issue(s).`);
      return {
        ok: false,
        error: {
          code: 'KB_RUNTIME_INPUT_INVALID',
          message: 'QA case catalog is invalid',
          hint: 'Run `kb qa cases list --help` to check command inputs, then retry.',
          diagnostics: catalog.diagnostics.map((diagnostic) => ({
            code: 'QA_CASE_INVALID',
            severity: 'error' as const,
            path: diagnostic.file,
            line: diagnostic.line,
            message: diagnostic.message,
          })),
        },
      };
    }
    if (!input.flags.json) ctx.ui?.success?.(`${catalog.cases.length} QA case(s)`, { sections: [{ items: catalog.cases.map(item => `${item.id} [${item.priority}] ${item.title} (${item.steps.length} steps)`) }] });
    return result;
  } },
});
