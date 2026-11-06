/**
 * @module @kb-labs/core-config/env-interpolation
 *
 * Resolves ${ENV_VAR} placeholders in platform config strings.
 * Applied once at startup — before config is used by loader.ts.
 *
 * Only string values are interpolated. Numbers, booleans, arrays of
 * non-strings are passed through unchanged.
 *
 * Throws if a referenced env var is missing (fail-fast in production).
 * Set required=false per-call to warn instead of throw (dev/test mode).
 */

import { createErrorEnvelope, ErrorEnvelopeError } from '@kb-labs/core-platform/error-envelope';

/**
 * Replace all ${VAR_NAME} patterns in a string with process.env values.
 * Throws if any referenced variable is undefined.
 */
export function interpolateString(
  value: string,
  required = true,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, varName: string) => {
    const resolved = env[varName];
    if (resolved === undefined) {
      if (required) {
        throw new ErrorEnvelopeError(createErrorEnvelope('KB_CONFIG_SECRET_MISSING', {
          details: { variable: varName },
        }));
      }
      // This runs before the platform logger exists, so use the process-level
      // log setting. In particular, silent must also apply to bootstrap
      // diagnostics; otherwise they leak before ILogger exists.
      if (shouldEmitBootstrapWarning(env)) {
        console.warn(
          `[kb-labs] Config warning: unresolved placeholder \${${varName}} — ` +
          `set the environment variable or remove the placeholder from config.`,
        );
      }
      return match;
    }
    return resolved;
  });
}

function shouldEmitBootstrapWarning(env: NodeJS.ProcessEnv): boolean {
  const level = (env.KB_LOG_LEVEL ?? env.LOG_LEVEL ?? 'info').toLowerCase();
  return level === 'trace' || level === 'debug' || level === 'info' || level === 'warn';
}

/**
 * Recursively walk an object and interpolate all string values.
 * Non-string primitives and arrays of non-strings are returned as-is.
 *
 * @param value  - Any JSON-compatible value
 * @param required - Whether to throw on missing env vars (default: true)
 */
export function interpolateConfig<T>(
  value: T,
  required = true,
  env: NodeJS.ProcessEnv = process.env,
): T {
  if (typeof value === 'string') {
    return interpolateString(value, required, env) as unknown as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => interpolateConfig(item, required, env)) as unknown as T;
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = interpolateConfig(v, required, env);
    }
    return result as T;
  }

  // number, boolean, null, undefined — pass through
  return value;
}
