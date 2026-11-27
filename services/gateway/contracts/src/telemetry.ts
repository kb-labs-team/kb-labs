/**
 * @module @kb-labs/gateway-contracts/telemetry
 * Telemetry ingestion schemas for the AI Gateway.
 *
 * External products send events through `POST /telemetry/v1/ingest`.
 * Events are written to platform analytics (SQLite/DuckDB/File) via IAnalytics.track().
 *
 * Schema is intentionally minimal — `payload` is free-form.
 * Platform provides recommended presets but does not enforce them.
 */
import { z } from 'zod';

// ── Single event ────────────────────────────────────────────────────────────

export const TelemetryEventSchema = z.object({
  /** Source product/service name (e.g., "my-api", "billing-service") */
  source: z.string().min(1).max(128),
  /** Event type/name using dot notation (e.g., "user.signup", "api.request") */
  type: z.string().min(1).max(256),
  /** ISO 8601 timestamp. Defaults to server ingest time if omitted. */
  timestamp: z.string().datetime().optional(),
  /** Free-form event data. No schema enforced — products decide what to send. */
  payload: z.record(z.string(), z.unknown()).optional(),
  /** Flat key-value tags for filtering/aggregation (e.g., { env: "prod", region: "eu" }) */
  tags: z.record(z.string(), z.string()).optional(),
});

export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;

// ── Batch ingestion request ─────────────────────────────────────────────────

export const TelemetryIngestRequestSchema = z.object({
  /** Array of events to ingest (1–500 per batch) */
  events: z.array(TelemetryEventSchema).min(1).max(500),
});

export type TelemetryIngestRequest = z.infer<typeof TelemetryIngestRequestSchema>;

// ── Ingestion response ──────────────────────────────────────────────────────

export interface TelemetryIngestResponse {
  /** Number of events accepted */
  accepted: number;
  /** Number of events rejected (validation errors) */
  rejected: number;
  /** Errors for rejected events, if any */
  errors?: Array<{ index: number; message: string }>;
}
