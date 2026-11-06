/** Platform-owned workflow CLI command handlers. */
import create from './commands/create.js';
import cronsDisable from './commands/crons-disable.js';
import cronsEnable from './commands/crons-enable.js';
import cronsList from './commands/crons-list.js';
import defsList from './commands/defs-list.js';
import defsView from './commands/defs-view.js';
import health from './commands/health.js';
import jobList from './commands/job-list.js';
import lint from './commands/lint.js';
import logShow from './commands/log-show.js';
import metrics from './commands/metrics.js';
import jobRun from './commands/run.js';
import runsApprove from './commands/runs-approve.js';
import runsCancel from './commands/runs-cancel.js';
import runsList from './commands/runs-list.js';
import runsLogs from './commands/runs-logs.js';
import runsRerun from './commands/runs-rerun.js';
import runsRestart from './commands/runs-restart.js';
import runsStatus from './commands/runs-status.js';
import runsView from './commands/runs-view.js';
import runsWatch from './commands/runs-watch.js';
import jobStatus from './commands/status.js';
import workflowRun from './commands/workflow-run.js';

export const workflowCommands = {
  create,
  cronsDisable,
  cronsEnable,
  cronsList,
  defsList,
  defsView,
  health,
  jobList,
  lint,
  logShow,
  metrics,
  jobRun,
  runsApprove,
  runsCancel,
  runsList,
  runsLogs,
  runsRerun,
  runsRestart,
  runsStatus,
  runsView,
  runsWatch,
  jobStatus,
  workflowRun,
};

export {
  createFlags, cronsListFlags, cronsToggleFlags, healthFlags, jobListFlags, jobStatusFlags,
  logShowFlags, metricsFlags, defsListFlags,
  defsViewFlags,
  lintFlags,
  runsApproveFlags,
  runsCancelFlags,
  runsListFlags,
  runsLogsFlags,
  runsRerunFlags,
  runsRestartFlags,
  runsStatusFlags,
  runsViewFlags,
  runsWatchFlags,
  runFlags,
  workflowRunFlags,
} from '@kb-labs/workflow-contracts';
export { workflowServiceCommands } from '@kb-labs/workflow-contracts/service-commands';
export type { CreateFlags, JobStatusFlags, JobListFlags, LogShowFlags, CronsListFlags, CronsToggleFlags } from '@kb-labs/workflow-contracts';
