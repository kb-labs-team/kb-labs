/**
 * Mock implementation of HealthDataSource, for Studio's mock data-source mode.
 */

import type {
  HealthDataSource,
  HealthReport,
  RequestUpdateParams,
  UpdateRequestRecord,
} from '../sources/health-source';

function makeReport(): HealthReport {
  return {
    ok: true,
    protocol: 1,
    installation: {
      ok: true,
      checks: [
        { id: 'receipt', ok: true, detail: 'platform 2.120.1, receipt r_sample' },
        { id: 'config', ok: true },
        { id: 'host-spec', ok: true, detail: 'kb-host' },
        { id: 'launcher-state', ok: true, detail: '/home/user/.kb/launcher' },
      ],
    },
    platform: {
      ok: true,
      checks: [
        { id: 'host-process', ok: true, detail: 'pid 4242' },
        { id: 'health', ok: true },
        { id: 'auth', ok: true },
      ],
    },
  };
}

export class MockHealthSource implements HealthDataSource {
  private report: HealthReport = makeReport();
  private pending: UpdateRequestRecord[] = [];

  async getHealth(): Promise<HealthReport> {
    return this.report;
  }

  async requestUpdate(params: RequestUpdateParams): Promise<UpdateRequestRecord> {
    const record: UpdateRequestRecord = {
      id: `upd_${Math.random().toString(16).slice(2).padEnd(16, '0')}`,
      status: 'pending',
      createdAt: new Date().toISOString(),
      ...(params.version !== undefined ? { version: params.version } : {}),
      ...(params.channel !== undefined ? { channel: params.channel } : {}),
      ...(params.requestedBy !== undefined ? { requestedBy: params.requestedBy } : {}),
    };
    this.pending = [...this.pending, record];
    return record;
  }
}
