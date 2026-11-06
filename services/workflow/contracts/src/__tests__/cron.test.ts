import { describe, expect, it } from 'vitest';
import { UserCronSchema } from '../cron.js';
import { WorkflowSpecSchema } from '../schemas.js';

describe('UserCronSchema', () => {
  it('accepts one schedule targeting an existing workflow with inputs', () => {
    expect(UserCronSchema.parse({
      id: 'nightly', schedule: '0 2 * * *', workflow: 'release',
      input: { channel: 'stable' },
    })).toMatchObject({ id: 'nightly', enabled: true, workflow: 'release', input: { channel: 'stable' } });
  });

  it('accepts handler targets and rejects invalid schedules or missing/duplicate targets', () => {
    expect(() => UserCronSchema.parse({ id: 'nightly', schedule: 'bad', workflow: 'release' })).toThrow();
    expect(UserCronSchema.parse({ id: 'nightly', schedule: '0 2 * * *', handler: 'plugin:job' }))
      .toMatchObject({ handler: 'plugin:job', enabled: true });
    expect(() => UserCronSchema.parse({ id: 'nightly', schedule: '0 2 * * *' })).toThrow(/exactly one/);
    expect(() => UserCronSchema.parse({
      id: 'nightly', schedule: '0 2 * * *', workflow: 'release', handler: 'plugin:job',
    })).toThrow(/exactly one/);
  });

  it('rejects workflow-level schedule declarations', () => {
    expect(() => WorkflowSpecSchema.parse({
      name: 'nightly', version: '1.0.0',
      on: { manual: true, schedule: { cron: '0 2 * * *' } },
      jobs: { task: { runsOn: 'local', steps: [{ name: 'run', uses: 'builtin:shell', with: { command: 'echo ok' } }] } },
    })).toThrow();
  });
});
