#!/usr/bin/env node
/**
 * @module @kb-labs/rest-api-app/bin
 * REST API executable entry point
 */

import { bootstrap } from "./bootstrap";

// process.cwd() = workspace root when launched via `node ./platform/kb-labs-rest-api/.../dist/bin.js`
bootstrap(process.cwd()).catch(() => {
  // runService() already emitted the canonical platform/service failure event.
  // Setting exitCode lets its logger flush without duplicating an unstructured stack.
  process.exitCode = 1;
});
