#!/usr/bin/env node
/**
 * @module @kb-labs/marketplace-app
 * Marketplace service entry point.
 */

import { bootstrap } from "./bootstrap.js";
import { listManagedGenerationEnvRefs, runManagedGenerationMutation, serializeManagedGenerationFailure } from "./managed-generation-mutation.js";

const managedMutationMode = process.argv[2] === "--managed-generation-mutation" || process.argv[2] === "--managed-generation-mutation-env-refs";
const run = process.argv[2] === "--managed-generation-mutation-env-refs"
  ? listManagedGenerationEnvRefs()
  : process.argv[2] === "--managed-generation-mutation"
    ? runManagedGenerationMutation()
    : bootstrap(process.cwd());

run.catch(error => {
  if (managedMutationMode) process.stderr.write(serializeManagedGenerationFailure(error));
  // runService() owns bootstrap failures; the managed helper emits a bounded
  // typed diagnostic above without exposing a stack or configuration values.
  process.exitCode = 1;
});
