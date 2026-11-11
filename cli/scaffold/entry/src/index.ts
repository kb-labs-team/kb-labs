import { defineSystemCommandGroup } from '@kb-labs/shared-command-kit';
import { scaffoldRun } from './commands/scaffold.js';
import { scaffoldDoctor } from './commands/doctor.js';

export const scaffoldGroup = defineSystemCommandGroup(
  'scaffold',
  'Scaffold KB Labs entities',
  [scaffoldRun, scaffoldDoctor],
);
