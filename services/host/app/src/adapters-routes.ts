/**
 * @module @kb-labs/host-app/adapters-routes
 *
 * Host-owned `/api/v1/adapters` API (stage 6, second slice): per-project
 * list (with each configured adapter's manifest `configSchema`) and
 * configure, over HTTP, so Studio can build a settings form without a
 * terminal. It calls the exact same operations as `kb config get|set` on
 * `adapterOptions.<name>` (`cli/commands/src/commands/system/config/{get,set}.ts`)
 * through `@kb-labs/core-config`'s `loadEffectiveConfig` / `setUserConfigValue`
 * / `createAdapterOptionsValidator` — the shared functions CLI already uses,
 * not a copy of the validation rules. Mounted on the gateway as
 * {@link HostRoutes} (`@kb-labs/gateway-app`), after the gateway's global auth
 * hooks — this module adds no authentication of its own.
 *
 * Adapters are configured per project here (config scope `project`): the
 * adapter package itself can only be *installed* in platform scope
 * (`AdapterScopeError` in `@kb-labs/marketplace-core`), but its options may be
 * overridden per project, same as `kb config set --scope project
 * adapterOptions.<name>.<key>`.
 *
 * Response shape mirrors the REST API's envelope (`{ ok: true, data }` /
 * `{ ok: false, error }`) so Studio's existing HTTP client and error mapper
 * handle it unchanged; `error` is the unified envelope (ADR-0049).
 */

import type { FastifyInstance } from "fastify";
import {
  configErrorEnvelope,
  loadAdapterConfigSchema,
  loadEffectiveConfig,
  redactValue,
  setUserConfigValue,
  ConfigWriteError,
  createAdapterOptionsValidator,
  resolveUserConfigFile,
  type ManifestConfigSchema,
} from "@kb-labs/core-config";
import { PlatformUserConfigSchema } from "@kb-labs/core-runtime";
import type { IProjectRegistry } from "@kb-labs/core-contracts";
import { projectErrorEnvelope, showProject } from "@kb-labs/core-project-registry";
import type { HostRoutes } from "@kb-labs/gateway-app";
import { invalidBody, sendData, sendEnvelope } from "./envelope.js";

export interface AdaptersRoutesOptions {
  registry: IProjectRegistry;
  platformRoot: string;
}

export interface AdapterEntry {
  /** Adapter slot name, e.g. `llm`, `cache`, `storage`. */
  name: string;
  /** Package spec currently bound to the slot (`platform.adapters.<name>`). */
  spec?: string;
  /** Manifest `configSchema`, when the adapter package could be resolved. */
  configSchema?: ManifestConfigSchema;
  /** Effective `adapterOptions.<name>` for this project, secrets redacted. */
  options: Record<string, unknown>;
}

interface ConfigureBody {
  projectId?: unknown;
  options?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function loadProjectAdapters(
  platformRoot: string,
  projectRoot: string,
): Promise<AdapterEntry[]> {
  const effective = await loadEffectiveConfig(projectRoot, { platformRoot });
  const platform = isRecord(effective?.data.platform) ? effective.data.platform : undefined;
  const adapters = isRecord(platform?.adapters) ? platform.adapters : {};
  const adapterOptions = isRecord(platform?.adapterOptions) ? platform.adapterOptions : {};

  const roots = [platformRoot, projectRoot];
  const entries: AdapterEntry[] = [];
  for (const [name, value] of Object.entries(adapters)) {
    const spec = Array.isArray(value) ? value[0] : value;
    const specStr = typeof spec === "string" && spec !== "" ? spec : undefined;
    const configSchema = specStr ? await loadAdapterConfigSchema(specStr, roots) : undefined;
    const options = isRecord(adapterOptions[name]) ? adapterOptions[name] : {};
    entries.push({
      name,
      spec: specStr,
      configSchema,
      options: redactValue(["adapterOptions", name], options) as Record<string, unknown>,
    });
  }
  return entries;
}

/**
 * Builds the `/api/v1/adapters` Fastify plugin. The gateway mounts it as
 * {@link HostRoutes} via `GatewayEmbedOptions.hostRoutes`.
 */
export function createAdaptersRoutes(options: AdaptersRoutesOptions): HostRoutes {
  const { registry, platformRoot } = options;

  return async function adaptersRoutes(app: FastifyInstance) {
    app.get<{ Querystring: { projectId?: string } }>(
      "/api/v1/adapters",
      async (request, reply) => {
        const { projectId } = request.query;
        if (typeof projectId !== "string" || projectId.trim() === "") {
          return sendEnvelope(reply, invalidBody("projectId", "must be a non-empty string"));
        }
        try {
          const project = await showProject(registry, projectId);
          const entries = await loadProjectAdapters(platformRoot, project.path);
          return sendData(reply, entries);
        } catch (error) {
          return sendEnvelope(reply, projectErrorEnvelope(error));
        }
      },
    );

    app.post<{ Params: { name: string }; Body: ConfigureBody }>(
      "/api/v1/adapters/:name/configure",
      async (request, reply) => {
        const { name } = request.params;
        const { projectId, options } = request.body ?? {};
        if (typeof projectId !== "string" || projectId.trim() === "") {
          return sendEnvelope(reply, invalidBody("projectId", "must be a non-empty string"));
        }
        if (!isRecord(options)) {
          return sendEnvelope(reply, invalidBody("options", "must be an object"));
        }

        try {
          const project = await showProject(registry, projectId);
          const projectRoot = project.path;
          const filePath = await resolveUserConfigFile(projectRoot);
          const effective = await loadEffectiveConfig(projectRoot, { platformRoot });
          const effectivePlatform = isRecord(effective?.data.platform) ? effective.data.platform : undefined;
          // Nested under `platform.adapterOptions.<name>`, matching where
          // `platform.adapters.<name>` (the slot -> spec binding) lives —
          // `PlatformUserConfigSchema` also accepts a bare top-level
          // `adapterOptions.<name>` (see `optionsHolder` in adapter-schema.ts),
          // but this is the form `kb config set`'s own examples document.
          const path = ["platform", "adapterOptions", name];
          const validate = createAdapterOptionsValidator(path, {
            roots: [platformRoot, projectRoot],
            effectiveAdapters: effectivePlatform?.adapters,
          });

          const result = await setUserConfigValue({
            filePath,
            path,
            value: options,
            schema: PlatformUserConfigSchema,
            validate,
          });

          return sendData(reply, {
            name,
            file: result.filePath,
            changed: result.changed,
            options: redactValue(path, options),
          });
        } catch (error) {
          if (error instanceof ConfigWriteError) {
            return sendEnvelope(reply, configErrorEnvelope(error));
          }
          return sendEnvelope(reply, projectErrorEnvelope(error));
        }
      },
    );
  };
}
