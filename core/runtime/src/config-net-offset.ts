/**
 * Shift loopback URLs into the local virtual network selected by kb-dev.
 *
 * kb-dev already injects KB_NET_OFFSET into every spawned service and applies
 * it to service ports/probes. Adapter endpoints live in platform config,
 * however, so an explicit `redis://localhost:6379` or
 * `http://localhost:6333` would otherwise still point at another
 * environment's infrastructure. Keep remote endpoints untouched: the offset
 * is strictly a local-development isolation mechanism.
 */
export function applyLocalNetworkOffset<T>(
  value: T,
  env: NodeJS.ProcessEnv = process.env,
): T {
  const offset = Number(env.KB_NET_OFFSET) || 0;
  if (value === null || typeof value !== "object") {
    return value;
  }

  const config = value as Record<string, unknown>;
  if (offset === 0 && !Array.isArray(config.networkOffsetExemptions)) {
    return value;
  }
  const exemptions = new Set(
    Array.isArray(config.networkOffsetExemptions)
      ? config.networkOffsetExemptions.filter((item): item is string => typeof item === "string")
      : [],
  );
  const { networkOffsetExemptions: _exemptions, ...configWithoutExemptions } = config;
  if (offset === 0) {
    return configWithoutExemptions as T;
  }
  return shiftConfigUrls(configWithoutExemptions, offset, "", exemptions) as T;
}

function shiftConfigUrls(
  value: unknown,
  offset: number,
  path: string,
  exemptions: ReadonlySet<string>,
): unknown {
  if (path && exemptions.has(path)) {
    return value;
  }
  if (typeof value === "string") {
    return shiftLoopbackUrl(value, offset);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => shiftConfigUrls(item, offset, `${path}.${index}`, exemptions));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    // service-transport-http already applies KB_NET_OFFSET itself. Shifting
    // its configured routes here as well would add the offset twice.
    const childPath = path ? `${path}.${key}` : key;
    result[key] = key === "serviceTransport"
      ? child
      : shiftConfigUrls(child, offset, childPath, exemptions);
  }
  return result;
}

function shiftLoopbackUrl(value: string, offset: number): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }

  if (
    !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) ||
    !url.port
  ) {
    return value;
  }

  const port = Number(url.port);
  if (!Number.isInteger(port) || port <= 0) {
    return value;
  }
  url.port = String(port + offset);
  const shifted = url.toString();
  // URL serialization adds a trailing slash to bare authority URLs. Keep the
  // configured spelling stable so config snapshots and diagnostics do not
  // change for a port-only rewrite.
  return /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+$/i.test(value)
    ? shifted.replace(/\/$/, "")
    : shifted;
}
