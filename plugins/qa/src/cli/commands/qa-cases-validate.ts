import { defineCommand, useConfig, type CLIInput, type CommandResult, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { parseQACatalog, scanQACaseClaims, validateReleaseCaseClaims } from '../../core/index.js';
import type { QAPluginConfig } from '../../contracts/index.js';
import type { QaCasesValidateFlags } from './flags.js';
import { resolveCatalogPath } from './qa-cases-utils.js';

export default defineCommand<unknown, CLIInput<QaCasesValidateFlags>, unknown>({
  id: 'qa:cases:validate',
  description: 'Validate the QA case catalog and test claims',
  handler: { async execute(ctx: PluginCommandContextV3, input: CLIInput<QaCasesValidateFlags>): Promise<CommandResult> {
    const cwd = ctx.cwd ?? process.cwd();
    const config = await useConfig<QAPluginConfig>();
    const catalog = parseQACatalog(resolveCatalogPath(cwd, config?.casesPath));
    const claims = scanQACaseClaims(cwd, catalog.cases);
    const diagnostics = [
      ...catalog.diagnostics,
      ...claims.diagnostics,
      ...validateReleaseCaseClaims(catalog.cases, claims.claims),
    ];
    const result = { schema: 'kb.qa-case-validation/v1', valid: diagnostics.length === 0, cases: catalog.cases.length, claims: claims.claims.length, diagnostics };
    if (diagnostics.length) {
      return { ok: false, error: { code: 'KB_RUNTIME_INPUT_INVALID', message: `QA case validation found ${diagnostics.length} issue(s).`, hint: 'Correct the reported case or claim entries, then rerun `kb qa cases validate --json`.', diagnostics: diagnostics.map((diagnostic) => ({ code: 'QA_CASE_INVALID', message: diagnostic.message, severity: 'error' as const, path: diagnostic.file, line: diagnostic.line })) } };
    }
    if (!input.flags.json) ctx.ui?.success?.(`Validated ${catalog.cases.length} case(s) and ${claims.claims.length} test claim(s).`);
    return result;
  } },
});
