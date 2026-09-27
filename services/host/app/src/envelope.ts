/**
 * @module @kb-labs/host-app/envelope
 *
 * Response envelope shared by every host-owned `/api/v1/*` route
 * (`projects-routes.ts`, `plugins-routes.ts`, `adapters-routes.ts`): `{ ok:
 * true, data }` / `{ ok: false, error }`, where `error` is the unified error
 * envelope (ADR-0049). Mirrors the REST API's shape so Studio's HTTP client
 * and error mapper handle every host route unchanged.
 */

import type { FastifyReply } from "fastify";
import { createErrorEnvelope, type ErrorEnvelope } from "@kb-labs/core-platform";

const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  KB_PROJECT_PATH_NOT_FOUND: 404,
  KB_PROJECT_NOT_A_DIRECTORY: 400,
  KB_PROJECT_NO_ACCESS: 403,
  KB_PROJECT_ALREADY_REGISTERED: 409,
  KB_PROJECT_UNKNOWN: 404,
  KB_PROJECT_NAME_TAKEN: 409,
  KB_PROJECT_DECLARATION_INVALID: 422,
  KB_PROJECT_REGISTRY_CORRUPT: 500,
  KB_PROJECT_REGISTRY_SCHEMA_UNSUPPORTED: 500,
  KB_PROJECT_REGISTRY_LOCKED: 503,
  KB_PROJECT_INIT_REQUIRED: 409,
  KB_RUNTIME_INPUT_INVALID: 400,
  KB_PLUGIN_NOT_FOUND: 404,
  KB_ADAPTER_NOT_CONFIGURED: 404,
  KB_CONFIG_UNKNOWN_KEY: 400,
  KB_CONFIG_INVALID: 400,
  KB_CONFIG_CONFLICT: 409,
  KB_CONFIG_SECRET_MISSING: 400,
  KB_CONFIG_SECRET_PLAINTEXT: 400,
};

export function statusFor(envelope: ErrorEnvelope): number {
  return STATUS_BY_CODE[envelope.code] ?? 500;
}

export function sendEnvelope(reply: FastifyReply, envelope: ErrorEnvelope): FastifyReply {
  return reply.code(statusFor(envelope)).send({ ok: false, error: envelope });
}

export function sendData(reply: FastifyReply, data: unknown, status = 200): FastifyReply {
  return reply.code(status).send({ ok: true, data });
}

export function invalidBody(field: string, expected: string): ErrorEnvelope {
  return createErrorEnvelope("KB_RUNTIME_INPUT_INVALID", {
    cause: `"${field}" ${expected}.`,
    details: { field },
  });
}
