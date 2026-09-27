import { createErrorEnvelope, type ErrorEnvelope } from "@kb-labs/core-platform";

/**
 * Thrown when the host would be reachable off the machine without
 * authentication. Carries the unified error envelope (`KB_HOST_EXPOSURE_REFUSED`)
 * so a launcher or CLI can render the catalog message and hint.
 */
export class HostExposureRefusedError extends Error {
  readonly envelope: ErrorEnvelope;

  constructor(bindHost: string) {
    const envelope = createErrorEnvelope("KB_HOST_EXPOSURE_REFUSED", {
      cause: `host.auth is "off" but the gateway binds to "${bindHost}", which is not a loopback address.`,
      details: { bindHost },
    });
    super(`${envelope.code}: ${envelope.message} ${envelope.hint}`);
    this.name = "HostExposureRefusedError";
    this.envelope = envelope;
  }
}
