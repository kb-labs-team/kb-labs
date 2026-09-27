/**
 * @module @kb-labs/host-app/launcher-control-client
 *
 * A thin TS client for the launcher's local control channel (ADR-0045): the
 * loopback, token-authenticated JSON protocol served by `kb-create supervise`
 * (`tools/kb-create/v2/control`). This is the only bridge from the host to
 * launcher lifecycle operations: `/api/v1/health` and `/api/v1/update` (see
 * `health-routes.ts`) call through this client rather than reimplementing
 * doctor or update logic.
 *
 * No shared code between Go and TS (ADR-0045 rule 4): the wire shapes below
 * are hand-kept in sync with `tools/kb-create/v2/control/protocol.go` and
 * verified against the shared fixtures in
 * `core/platform/src/launcher-control/fixtures/v1` (see this module's test).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createErrorEnvelope, type ErrorEnvelope } from "@kb-labs/core-platform";
import { resolveKbHome } from "@kb-labs/core-project-registry";

/** `control.json`, written by the launcher (mode 0600) and removed on exit. */
interface ControlFile {
  protocol: number;
  address: string;
  token: string;
  pid: number;
  version: string;
}

export interface DoctorCheck {
  id: string;
  ok: boolean;
  detail?: string;
  hint?: string;
}

export interface DoctorSection {
  ok: boolean;
  checks: DoctorCheck[];
}

/** Body of `GET /v1/doctor`: `doctor.InspectInstallation`/`InspectPlatform`, unchanged. */
export interface DoctorResponse {
  ok: boolean;
  protocol: number;
  installation: DoctorSection;
  platform: DoctorSection;
}

export interface LauncherInfo {
  version: string;
  pid: number;
  startedAt: string;
}

export type HostRunState = "stopped" | "running" | "unhealthy";

export interface HostStatus {
  runner: string;
  state: HostRunState;
  pid?: number;
  healthy?: boolean;
  healthUrl?: string;
  startedAt?: string;
}

/** Body of `GET /v1/status`. */
export interface StatusResponse {
  ok: boolean;
  protocol: number;
  launcher: LauncherInfo;
  host: HostStatus;
  updateRequests: { pending: number };
}

export type UpdateChannel = "stable" | "canary" | "experimental";

/** Body of `POST /v1/update-request`; exactly one of version/channel is set. */
export interface UpdateRequestInput {
  version?: string;
  channel?: UpdateChannel;
  requestedBy?: string;
}

export interface UpdateRequestRecord {
  id: string;
  status: string;
  version?: string;
  channel?: string;
  requestedBy?: string;
  createdAt: string;
}

export interface UpdateRequestResponse {
  ok: boolean;
  protocol: number;
  request: UpdateRequestRecord;
}

/** Thrown by every client call; `envelope` is the unified error envelope (ADR-0049). */
export class LauncherControlError extends Error {
  readonly envelope: ErrorEnvelope;

  constructor(envelope: ErrorEnvelope, cause?: unknown) {
    super(`${envelope.code}: ${envelope.message}`, cause !== undefined ? { cause } : undefined);
    this.name = "LauncherControlError";
    this.envelope = envelope;
  }
}

export function isLauncherControlError(error: unknown): error is LauncherControlError {
  return error instanceof LauncherControlError;
}

function unavailable(cause?: unknown): LauncherControlError {
  return new LauncherControlError(
    createErrorEnvelope("KB_HOST_CONTROL_UNAVAILABLE", {
      ...(cause instanceof Error ? { cause: cause.message } : {}),
    }),
    cause,
  );
}

/** Mirrors `host.ProcessAlive` (Go): a signal-0 probe, portable on POSIX and Windows. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface LauncherControlClientOptions {
  env?: NodeJS.ProcessEnv;
  /** Request timeout in ms; defaults to 10s. */
  timeoutMs?: number;
}

/**
 * Connects to the launcher control channel by reading `control.json` from the
 * per-user launcher state home (`<KB_HOME>/launcher`, the same `KB_HOME` the
 * project registry uses). A file left behind by a crashed launcher is ignored,
 * matching the Go client (`control.Connect`): the caller sees
 * `KB_HOST_CONTROL_UNAVAILABLE` either way.
 */
export async function connectLauncherControl(
  options: LauncherControlClientOptions = {},
): Promise<LauncherControlClient> {
  const kbHome = resolveKbHome(options.env);
  const controlPath = join(kbHome, "launcher", "control.json");
  let raw: string;
  try {
    raw = await readFile(controlPath, "utf8");
  } catch (error) {
    throw unavailable(error);
  }
  let file: ControlFile;
  try {
    file = JSON.parse(raw) as ControlFile;
  } catch (error) {
    throw unavailable(error);
  }
  if (!isProcessAlive(file.pid)) {
    throw unavailable(new Error(`launcher process ${file.pid} is not running`));
  }
  return new LauncherControlClient(file, options.timeoutMs ?? 10_000);
}

/** Talks to a running launcher through its control channel. */
export class LauncherControlClient {
  constructor(
    private readonly file: ControlFile,
    private readonly timeoutMs: number,
  ) {}

  status(): Promise<StatusResponse> {
    return this.request<StatusResponse>("GET", "/v1/status");
  }

  doctor(): Promise<DoctorResponse> {
    return this.request<DoctorResponse>("GET", "/v1/doctor");
  }

  requestUpdate(input: UpdateRequestInput): Promise<UpdateRequestResponse> {
    return this.request<UpdateRequestResponse>("POST", "/v1/update-request", input);
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`http://${this.file.address}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.file.token}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw unavailable(error);
    }
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined;
    } catch (error) {
      throw unavailable(error);
    }
    if (!response.ok) {
      const failure = parsed as { ok?: boolean; error?: ErrorEnvelope } | undefined;
      if (failure?.error) {
        throw new LauncherControlError(failure.error);
      }
      throw unavailable(new Error(`control channel replied with status ${response.status}`));
    }
    return parsed as T;
  }
}
