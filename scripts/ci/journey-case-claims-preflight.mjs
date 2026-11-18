import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseQACatalog } from '../../plugins/qa/src/core/cases/catalog.ts';
import { scanQACaseClaims } from '../../plugins/qa/src/core/cases/claims.ts';

export function validateJourneyCaseDeclarations(root = process.cwd()) {
  const catalogPath = resolve(root, 'docs/qa/scenarios');
  const catalog = parseQACatalog(catalogPath);
  const scan = scanQACaseClaims(root, catalog.cases);
  const journeyDiagnostics = scan.diagnostics.filter((diagnostic) => {
    const sourcePath = relative(root, resolve(process.cwd(), diagnostic.file));
    return sourcePath.startsWith('e2e/journey/');
  });
  return {
    caseCount: catalog.cases.length,
    journeyClaimCount: scan.claims.filter((claim) => claim.source.startsWith('e2e/journey/')).length,
    diagnostics: [...catalog.diagnostics, ...journeyDiagnostics],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = validateJourneyCaseDeclarations();
  if (result.diagnostics.length > 0) {
    process.stderr.write(`Journey case declaration preflight found ${result.diagnostics.length} issue(s):\n`);
    for (const diagnostic of result.diagnostics) {
      process.stderr.write(`${diagnostic.file}:${diagnostic.line}: ${diagnostic.message}\n`);
    }
    process.exitCode = 1;
  } else {
    process.stdout.write(`Validated ${result.caseCount} case(s) and ${result.journeyClaimCount} journey claim(s).\n`);
  }
}
