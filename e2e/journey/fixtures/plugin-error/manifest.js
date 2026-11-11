export const manifest = {
  schema: 'kb.plugin/3',
  id: '@kb-labs/e2e-plugin-error',
  version: '1.0.0',
  display: {
    name: 'Journey Plugin Error Fixture',
    description: 'Throws a nested plain Error for log correlation coverage',
  },
  cli: {
    groupMeta: [{ path: 'journey-error', describe: 'Journey plugin failure fixture commands' }],
    commands: [
      {
        path: 'journey-error throw',
        describe: 'Throw a nested plain Error for diagnostic coverage',
        operationType: 'execute',
        handler: './commands/throw.js#execute',
        flags: [
          { name: 'secret', type: 'string', description: 'Sensitive fixture value', required: true, secret: true },
        ],
      },
    ],
  },
};
