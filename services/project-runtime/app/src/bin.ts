#!/usr/bin/env node
import { parseRuntimeArgs, RuntimeArgsError } from "./args.js";
import { createProjectRuntimeConfig } from "./runtime.js";
import { runHost } from "@kb-labs/shared-daemon";
import { watchParent } from "./watchdog.js";

async function main(): Promise<void> {
  const args = await parseRuntimeArgs(process.argv.slice(2), process.env);

  // The platform resolves its roots from the environment first; make the
  // environment agree with the project this runtime was started for.
  process.env.KB_PROJECT_ROOT = args.projectRoot;

  await runHost(
    await createProjectRuntimeConfig({
      projectRoot: args.projectRoot,
      projectId: args.projectId,
      listen: args.listen,
      token: args.token,
      moduleUrl: import.meta.url,
    }),
  );

  if (args.parentPid !== undefined) {
    watchParent({
      parentPid: args.parentPid,
      onParentGone: () => {
        // The host is gone: take the runtime down through the normal path
        // (modules in reverse order, platform shutdown, one exit code).
        process.kill(process.pid, "SIGTERM");
      },
    });
  }
}

main().catch((error: unknown) => {
  if (error instanceof RuntimeArgsError) {
    process.stderr.write(`kb-project-runtime: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  // runHost already logged a startup failure; the host reads stderr for the cause.
  process.stderr.write(
    `kb-project-runtime: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
