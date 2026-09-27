/**
 * @module @kb-labs/host-app/health-routes
 *
 * Host-owned `/api/v1/health` and `/api/v1/update` (stage 6, final slice):
 * Studio's health/status screen and its "Update" action, bridged to the
 * launcher's control channel (ADR-0045) instead of reimplementing doctor or
 * update-request logic. Mounted on the gateway as a {@link HostRoutes}
 * (`@kb-labs/gateway-app`), the same way as {@link createProjectsRoutes}.
 *
 * - `GET /api/v1/health` calls `GET /v1/doctor` on the control channel and
 *   returns the same installation/platform sections `kb-create doctor` prints.
 * - `POST /api/v1/update` calls `POST /v1/update-request`: it queues the
 *   request with the launcher and returns the queued record immediately
 *   (202); the launcher performs the update and restarts the host later,
 *   asynchronously — this request never blocks on that.
 *
 * Both surface `KB_HOST_CONTROL_UNAVAILABLE` when no launcher is supervising
 * this host (for example, the host was started directly rather than through
 * `kb-create start`) and `KB_HOST_CONTROL_UNAUTHORIZED` if the control
 * channel's token on disk is stale. Response shape mirrors the REST API's
 * envelope (`{ ok: true, data }` / `{ ok: false, error }`), `error` being the
 * unified envelope (ADR-0049).
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { createErrorEnvelope, type ErrorEnvelope } from "@kb-labs/core-platform";
import type { HostRoutes } from "@kb-labs/gateway-app";
import {
  connectLauncherControl,
  isLauncherControlError,
  type LauncherControlClientOptions,
  type UpdateChannel,
} from "./launcher-control-client.js";

export interface HealthRoutesOptions {
  /** Overrides for reaching the control channel; used by tests. */
  controlClient?: LauncherControlClientOptions;
}

const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  KB_HOST_CONTROL_UNAVAILABLE: 503,
  KB_HOST_CONTROL_UNAUTHORIZED: 502,
  KB_RUNTIME_RATE_LIMITED: 429,
  KB_RUNTIME_INPUT_INVALID: 400,
};

function statusFor(envelope: ErrorEnvelope): number {
  return STATUS_BY_CODE[envelope.code] ?? 500;
}

function sendEnvelope(reply: FastifyReply, envelope: ErrorEnvelope): FastifyReply {
  return reply.code(statusFor(envelope)).send({ ok: false, error: envelope });
}

function sendData(reply: FastifyReply, data: unknown, status = 200): FastifyReply {
  return reply.code(status).send({ ok: true, data });
}

/** Rethrows anything that is not a control-channel failure; routes only translate that one shape. */
function controlEnvelope(error: unknown): ErrorEnvelope {
  if (isLauncherControlError(error)) {
    return error.envelope;
  }
  throw error;
}

const UPDATE_CHANNELS: ReadonlySet<string> = new Set<UpdateChannel>(["stable", "canary", "experimental"]);

interface UpdateBody {
  version?: unknown;
  channel?: unknown;
  requestedBy?: unknown;
}

function invalidBody(field: string, expected: string): ErrorEnvelope {
  return createErrorEnvelope("KB_RUNTIME_INPUT_INVALID", {
    cause: `"${field}" ${expected}.`,
    details: { field },
  });
}

/** Validates the body against the launcher's own rule: exactly one of version|channel. */
function validateUpdateBody(
  body: UpdateBody,
): { version?: string; channel?: UpdateChannel; requestedBy?: string } | ErrorEnvelope {
  const { version, channel, requestedBy } = body;
  if (version !== undefined && typeof version !== "string") {
    return invalidBody("version", "must be a string");
  }
  if (channel !== undefined && (typeof channel !== "string" || !UPDATE_CHANNELS.has(channel))) {
    return invalidBody("channel", "must be one of stable, canary, experimental");
  }
  if (requestedBy !== undefined && typeof requestedBy !== "string") {
    return invalidBody("requestedBy", "must be a string");
  }
  if ((version === undefined) === (channel === undefined)) {
    return invalidBody("version, channel", "requires exactly one of version or channel");
  }
  return {
    ...(version !== undefined ? { version: version as string } : {}),
    ...(channel !== undefined ? { channel: channel as UpdateChannel } : {}),
    ...(requestedBy !== undefined ? { requestedBy: requestedBy as string } : {}),
  };
}

/**
 * Builds the `/api/v1/health` + `/api/v1/update` Fastify plugin. The gateway
 * mounts it as {@link HostRoutes} via `GatewayEmbedOptions.hostRoutes`.
 */
export function createHealthRoutes(options: HealthRoutesOptions = {}): HostRoutes {
  const clientOptions = options.controlClient ?? {};

  return async function healthRoutes(app: FastifyInstance) {
    app.get("/api/v1/health", async (_request, reply) => {
      try {
        const client = await connectLauncherControl(clientOptions);
        const doctor = await client.doctor();
        return sendData(reply, doctor);
      } catch (error) {
        return sendEnvelope(reply, controlEnvelope(error));
      }
    });

    app.post<{ Body: UpdateBody }>("/api/v1/update", async (request, reply) => {
      const validated = validateUpdateBody(request.body ?? {});
      if ("code" in validated) {
        return sendEnvelope(reply, validated);
      }
      try {
        const client = await connectLauncherControl(clientOptions);
        const accepted = await client.requestUpdate(validated);
        return sendData(reply, accepted.request, 202);
      } catch (error) {
        return sendEnvelope(reply, controlEnvelope(error));
      }
    });
  };
}
