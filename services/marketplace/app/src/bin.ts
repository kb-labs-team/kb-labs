#!/usr/bin/env node
/**
 * @module @kb-labs/marketplace-app
 * Marketplace service entry point.
 */

import { bootstrap } from "./bootstrap.js";
import { listManagedGenerationEnvRefs, runManagedGenerationMutation } from "./managed-generation-mutation.js";

const run = process.argv[2] === "--managed-generation-mutation-env-refs"
  ? listManagedGenerationEnvRefs()
  : process.argv[2] === "--managed-generation-mutation"
    ? runManagedGenerationMutation()
    : bootstrap(process.cwd());

run.catch(() => {
  // runService() already emitted the canonical platform/service failure event.
  // Setting exitCode lets its logger flush without duplicating an unstructured stack.
  process.exitCode = 1;
});
