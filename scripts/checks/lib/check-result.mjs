import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CHECK_RESULT_FILE_ENV = readFileSync(
  new URL('../../../tools/kb-devkit/internal/checks/external-check-result-env.txt', import.meta.url),
  'utf8',
).trim();

/** Write the kb-devkit result synchronously before a check exits. */
export function writeCheckResult(issues) {
  const check = process.env.KB_DEVKIT_CHECK_NAME;
  const namedIssues = issues.map((issue) => issue.check ? issue : { ...issue, check });
  const result = `${JSON.stringify({ issues: namedIssues })}\n`;
  const resultPath = process.env[CHECK_RESULT_FILE_ENV];
  if (resultPath) {
    writeFileSync(resultPath, result, { encoding: 'utf8', flag: 'w', mode: 0o600 });
    return;
  }
  process.stdout.write(result);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  writeCheckResult([]);
}
