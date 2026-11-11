import { defineSystemCommandGroup } from '@kb-labs/shared-command-kit';
import { workspaceList } from './list.js';
import { workspaceRegister } from './register.js';
import { workspaceStatus } from './status.js';

export const workspaceAgentGroup = defineSystemCommandGroup('workspace', 'Workspace Agent commands', [
  workspaceRegister,
  workspaceStatus,
  workspaceList,
]);
