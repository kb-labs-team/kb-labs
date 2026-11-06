/**
 * @module @kb-labs/workflow-daemon/api
 * REST API routes for Workflow Service
 */

export { registerJobsAPI, type JobsAPIOptions } from './jobs-api.js';
export { registerCronAPI, type CronAPIOptions } from './cron-api.js';
export { registerApprovalsAPI, type ApprovalsAPIOptions } from './approvals-api.js';
export {
  ok,
  fail,
  type ApiResponse,
  type ApiSuccessResponse,
  type ApiErrorResponse,
} from './response.js';
