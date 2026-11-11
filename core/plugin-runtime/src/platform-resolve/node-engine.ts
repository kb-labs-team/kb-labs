import { createErrorEnvelope, ErrorEnvelopeError } from '@kb-labs/core-platform';
import { nodeVersionSupported, readNodeEnginePolicy, runtimePackageManifest } from './node-engine.mjs';

export function ensureNodeEngineSupported(moduleURL: string, actualVersion = process.versions.node): void {
  const { requiredMajor } = readNodeEnginePolicy(runtimePackageManifest(moduleURL));
  if (nodeVersionSupported(requiredMajor, actualVersion)) {return;}
  throw new ErrorEnvelopeError(createErrorEnvelope('KB_NODE_VERSION_UNSUPPORTED', {
    details: { requiredMajor: String(requiredMajor), actualVersion: actualVersion.replace(/^v/, '') },
  }));
}
