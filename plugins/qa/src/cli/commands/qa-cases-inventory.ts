import { defineCommand, useConfig, type CLIInput, type CommandResult, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { buildQACaseEvidenceInventory, parseQACatalog, scanQACaseClaims } from '../../core/index.js';
import type { QAPluginConfig } from '../../contracts/index.js';
import type { QaCasesInventoryFlags } from './flags.js';
import { resolveCatalogPath } from './qa-cases-utils.js';

export default defineCommand<unknown, CLIInput<QaCasesInventoryFlags>, unknown>({
  id: 'qa:cases:inventory',
  description: 'Inventory case claims and runtime evidence matrix gaps',
  handler: { async execute(ctx: PluginCommandContextV3, input: CLIInput<QaCasesInventoryFlags>): Promise<CommandResult> {
    const cwd = ctx.cwd ?? process.cwd();
    const config = await useConfig<QAPluginConfig>();
    const catalog = parseQACatalog(resolveCatalogPath(cwd, config?.casesPath));
    const scanned = scanQACaseClaims(cwd, catalog.cases);
    const diagnostics = [...catalog.diagnostics, ...scanned.diagnostics];
    if (diagnostics.length) {
      return {
        ok: false,
        error: {
          code: 'KB_RUNTIME_INPUT_INVALID',
          message: 'QA case evidence inventory inputs are invalid',
          hint: 'Fix the listed case or claim inputs, then rerun `kb qa cases inventory --json`.',
          diagnostics: diagnostics.map(item => ({
            code: 'KB_QA_CASE_INVENTORY_INPUT_INVALID', severity: 'error' as const,
            path: item.file, line: item.line, message: item.message,
          })),
        },
      };
    }
    const inventory = buildQACaseEvidenceInventory(catalog.cases, scanned.claims);
    if (!input.flags.json) {
      ctx.ui?.success?.(`Inventoried ${inventory.totals.steps} case step(s); ${inventory.totals.activeReleaseStepsWithoutJourneyOrE2EClaim} active release step(s) lack a journey/e2e claim.`);
    }
    return inventory;
  } },
});
