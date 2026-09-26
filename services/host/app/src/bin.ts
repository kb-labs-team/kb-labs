#!/usr/bin/env node
import { HostExposureRefusedError } from "./errors.js";
import { startHost } from "./host.js";

// process.cwd() = the directory platform/project roots are resolved from.
startHost({ startDir: process.cwd(), moduleUrl: import.meta.url }).catch(
  (error: unknown) => {
    if (error instanceof HostExposureRefusedError) {
      // Machine-readable envelope for the launcher; runHost already logged the failure.
      process.stderr.write(`${JSON.stringify(error.envelope)}\n`);
    }
    // Setting exitCode lets the logger flush without duplicating a stack trace.
    process.exitCode = 1;
  },
);
