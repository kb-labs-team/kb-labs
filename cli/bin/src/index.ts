import { executeCli } from "./runtime/bootstrap";
import type { CliResultWriter } from './runtime/result-serializer.js';

/**
 * CLI entry point.
 *
 * @param argv  Arguments, typically `process.argv.slice(2)`.
 * @param opts  Runtime context from the CLI launcher. `moduleUrl` identifies
 *              the installed binary for platform-root resolution.
 */
export async function run(
  argv: string[],
  opts: { moduleUrl?: string; resultWriter: CliResultWriter },
): Promise<number | void> {
  return executeCli(argv, { moduleUrl: opts.moduleUrl, resultWriter: opts.resultWriter });
}
