/**
 * HTTP implementation of HealthDataSource, over the host's `/api/v1/health`
 * and `/api/v1/update` APIs.
 */

import type { HttpClient } from '../client/http-client';
import type {
  HealthDataSource,
  HealthReport,
  RequestUpdateParams,
  UpdateRequestRecord,
} from './health-source';

export class HttpHealthSource implements HealthDataSource {
  constructor(private readonly client: HttpClient) {}

  async getHealth(): Promise<HealthReport> {
    return this.client.fetch<HealthReport>('/health');
  }

  async requestUpdate(params: RequestUpdateParams): Promise<UpdateRequestRecord> {
    return this.client.fetch<UpdateRequestRecord>('/update', {
      method: 'POST',
      data: params,
    });
  }
}
