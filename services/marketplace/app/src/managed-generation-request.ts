export type ManagedGenerationRequest =
  | { operation: "install"; specs: string[]; dev?: boolean }
  | { operation: "uninstall" | "update"; packageIds: string[] }
  | { operation: "enable" | "disable"; packageId: string };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseManagedGenerationMutation(value: unknown): ManagedGenerationRequest {
  if (!record(value) || typeof value.operation !== "string") throw new Error("invalid managed Marketplace request");
  const allowed = value.operation === "install" ? ["operation", "specs", "dev"]
    : value.operation === "uninstall" || value.operation === "update" ? ["operation", "packageIds"]
      : value.operation === "enable" || value.operation === "disable" ? ["operation", "packageId"] : [];
  if (!allowed.length || Object.keys(value).some(key => !allowed.includes(key))) throw new Error("unsupported managed Marketplace request fields");
  if (value.operation === "install") {
    if (!Array.isArray(value.specs) || value.specs.length < 1 || value.specs.length > 32 || !value.specs.every(item => typeof item === "string" && item.length <= 512) || (value.dev !== undefined && typeof value.dev !== "boolean")) throw new Error("invalid managed install request");
    return { operation: "install", specs: value.specs as string[], ...(value.dev === true ? { dev: true } : {}) };
  }
  if (value.operation === "uninstall" || value.operation === "update") {
    if (!Array.isArray(value.packageIds) || value.packageIds.length < 1 || value.packageIds.length > 32 || !value.packageIds.every(item => typeof item === "string" && item.length <= 256)) throw new Error("invalid managed package ID request");
    return { operation: value.operation, packageIds: value.packageIds as string[] };
  }
  if ((value.operation !== "enable" && value.operation !== "disable") || typeof value.packageId !== "string" || value.packageId.length > 256) throw new Error("invalid managed package ID request");
  return { operation: value.operation, packageId: value.packageId };
}
