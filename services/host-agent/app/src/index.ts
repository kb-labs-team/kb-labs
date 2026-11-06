/**
 * Library entry point — `main` / `exports["."]`.
 *
 * This module is safe to `import` on its own: it only re-exports functions
 * and types, with zero side effects at import time. Actually running the
 * daemon (as a process) happens in `bin.ts`, which is what the `kb-host-agent`
 * executable points at. Anything that merely imports this package (a
 * downstream library consumer, the pack-install verification, tooling that
 * pulls in types) must not trigger daemon startup as a side effect.
 */

export { startDaemon } from './daemon.js';
