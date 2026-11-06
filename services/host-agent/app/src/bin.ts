#!/usr/bin/env node
/**
 * bin.ts — CLI/executable entry point for `kb-host-agent`.
 *
 * This is the module the `bin` field points at. It is the only place in the
 * package that actually starts the daemon as a running process — importing
 * the package's library entry (`index.ts`) must never do this.
 */

import { startDaemon } from './daemon.js';

startDaemon().catch((err) => {
  console.error('[host-agent] Fatal error:', err);
  process.exit(1);
});
