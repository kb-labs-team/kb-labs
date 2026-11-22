export type ManagedGenerationRequest =
  | { operation: "install"; specs: string[]; dev?: boolean }
  | { operation: "update"; packageIds?: string[] };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseManagedGenerationMutation(value: unknown): ManagedGenerationRequest {
  if (!record(value) || typeof value.operation !== "string") throw new Error("invalid managed Marketplace request");
  const allowed = value.operation === "install" ? ["operation", "specs", "dev"]
    : value.operation === "update" ? ["operation", "packageIds"] : [];
  if (!allowed.length || Object.keys(value).some(key => !allowed.includes(key))) throw new Error("unsupported managed Marketplace request fields");
  if (value.operation === "install") {
    if (!Array.isArray(value.specs) || value.specs.length < 1 || value.specs.length > 32 || !value.specs.every(item => typeof item === "string" && item.length <= 512) || (value.dev !== undefined && typeof value.dev !== "boolean")) throw new Error("invalid managed install request");
    return { operation: "install", specs: value.specs as string[], ...(value.dev === true ? { dev: true } : {}) };
  }
  if (value.operation === "update") {
    const ids = value.packageIds;
    if (ids !== undefined && (!Array.isArray(ids) || ids.length < 1 || ids.length > 32
      || !ids.every(item => typeof item === "string" && /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(item) && item.length <= 214)
      || new Set(ids).size !== ids.length)) throw new Error("invalid managed adapter update request");
    return { operation: "update", ...(ids === undefined ? {} : { packageIds: ids as string[] }) };
  }
  throw new Error("unsupported managed Marketplace operation");
}
