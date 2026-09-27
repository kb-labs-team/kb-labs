/**
 * Host health/status data source (stage 6, final slice). Backed by the host's
 * `/api/v1/health` and `/api/v1/update` APIs, which bridge to the launcher's
 * control channel (ADR-0045) rather than reimplementing doctor or update
 * logic — this is the same report `kb-create doctor` prints and the same
 * queue `kb-create` consumes for an update.
 */

export interface HealthCheck {
  id: string;
  ok: boolean;
  detail?: string;
  hint?: string;
}

export interface HealthSection {
  ok: boolean;
  checks: HealthCheck[];
}

/** `GET /api/v1/health` response: `doctor.InspectInstallation`/`InspectPlatform`, unchanged. */
export interface HealthReport {
  ok: boolean;
  protocol: number;
  installation: HealthSection;
  platform: HealthSection;
}

export type UpdateChannel = 'stable' | 'canary' | 'experimental';

/** Exactly one of `version`/`channel` is required. */
export interface RequestUpdateParams {
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

export interface HealthDataSource {
  getHealth(): Promise<HealthReport>;
  /** Queues an update with the launcher; the launcher performs it and restarts the host. */
  requestUpdate(params: RequestUpdateParams): Promise<UpdateRequestRecord>;
}
