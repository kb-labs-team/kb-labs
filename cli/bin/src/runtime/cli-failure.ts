import path from 'node:path';
import { writeCliResultTo } from './result-serializer.js';

export async function reportCliResultFailure(cause: string): Promise<void> {
  const [{ createErrorEnvelope }, { createJsonPresenter, createTextPresenter }, { handleExecutionError }] = await Promise.all([
    import('@kb-labs/core-platform'),
    import('@kb-labs/cli-runtime'),
    import('./execution-error.js'),
  ]);
  const binary = path.basename(process.argv[1] ?? 'kb');
  const envelope = createErrorEnvelope('KB_CLI_RESULT_UNAVAILABLE', {
    cause,
    details: { binary, cause },
    templateValues: { binary, cause },
  });
  const presenter = process.argv.includes('--json')
    ? createJsonPresenter((value) => writeCliResultTo(1, value))
    : createTextPresenter((value) => writeCliResultTo(1, value));
  handleExecutionError(new Error(cause), presenter, { envelope });
}
