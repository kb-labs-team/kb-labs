import type { ProjectServiceApiDeclaration, ProjectServiceDeclaration, ServiceManifest } from "./manifest.js";

export class ProjectServiceManifestError extends Error {
  readonly code = "KB_CONFIG_INVALID";
  readonly details: { path: string };
  readonly hint: string;

  constructor(message: string, path = "serviceManifest.projectApi") {
    super(message);
    this.name = "ProjectServiceManifestError";
    this.details = { path };
    this.hint = path === "serviceManifest.runtime.healthCheck"
      ? "Set runtime.healthCheck to an HTTP URL or absolute health path, then restart the host."
      : "Correct projectApi.serviceId and projectApi.rewritePrefix in the service manifest, then restart the host.";
  }
}

/** Enforce the public service namespace contract at a declaration boundary. */
export function validateProjectServiceDeclarations(
  declarations: readonly ProjectServiceApiDeclaration[],
): ProjectServiceApiDeclaration[] {
  const serviceIds = new Set<string>();
  for (const declaration of declarations) {
    if (!/^[a-z][a-z0-9-]*$/.test(declaration.serviceId)) {
      throw new ProjectServiceManifestError(
        `Invalid project service id "${declaration.serviceId}". Use a lowercase URL segment containing letters, digits, and hyphens.`,
      );
    }
    if (serviceIds.has(declaration.serviceId)) {
      throw new ProjectServiceManifestError(
        `Duplicate project service id "${declaration.serviceId}" in project service declarations.`,
      );
    }
    if (
      !declaration.rewritePrefix.startsWith("/") ||
      (declaration.rewritePrefix.endsWith("/") && declaration.rewritePrefix !== "/")
    ) {
      throw new ProjectServiceManifestError(
        `Invalid project service rewritePrefix "${declaration.rewritePrefix}". It must be an absolute path without a trailing slash.`,
      );
    }
    serviceIds.add(declaration.serviceId);
  }
  return declarations.map((declaration) => ({ ...declaration }));
}

/** Validate and collect project URL declarations from service manifests. */
export function collectProjectServiceDeclarations(
  manifests: readonly ServiceManifest[],
): ProjectServiceDeclaration[] {
  validateProjectServiceDeclarations(
    manifests.flatMap((manifest) => manifest.projectApi ? [manifest.projectApi] : []),
  );
  return manifests.flatMap((manifest) => {
    if (!manifest.projectApi) {return [];}
    const declaredHealthCheck = manifest.runtime.healthCheck;
    let healthCheck: string;
    if (declaredHealthCheck.startsWith("/")) {
      healthCheck = declaredHealthCheck.split("?", 1)[0] ?? declaredHealthCheck;
    } else {
      try {
        const healthUrl = new URL(declaredHealthCheck);
        if (!["http:", "https:"].includes(healthUrl.protocol)) {
          throw new Error("unsupported health check URL");
        }
        healthCheck = healthUrl.pathname;
      } catch {
        throw new ProjectServiceManifestError(
          `Invalid service health check "${declaredHealthCheck}". A project service must declare an absolute health path or HTTP URL.`,
          "serviceManifest.runtime.healthCheck",
        );
      }
    }
    if (!healthCheck || healthCheck === "/") {
      throw new ProjectServiceManifestError(
        `Invalid service health check "${declaredHealthCheck}". A project service must declare a non-root health path.`,
        "serviceManifest.runtime.healthCheck",
      );
    }
    return [{ ...manifest.projectApi, healthCheck }];
  });
}
