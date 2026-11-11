import { DockerEnvironmentAdapter } from '@kb-labs/adapters-environment-docker';
import { createStdioChannel } from '@kb-labs/core-ipc';

const image = process.env.KB_CONTAINER_TEST_IMAGE;
const runId = process.env.KB_CONTAINER_TEST_RUN_ID;
const workspacePath = process.env.KB_CONTAINER_TEST_WORKSPACE;
if (!image || !runId || !workspacePath) {
  throw new Error('Docker host-client fixture requires image, run id, and workspace path');
}

const adapter = new DockerEnvironmentAdapter({
  defaultImage: image,
  runtimeCommand: ['node', '/workspace/core/plugin-runtime/dist/sandbox/bootstrap.js'],
});
const { environmentId } = await adapter.reserve({ runId });
const started = await adapter.start(environmentId, {
  workspacePath,
  executionPolicy: {
    mounts: [{ path: '.', access: 'read-only' }],
    environment: {},
  },
});
const stream = adapter.getExecutionStream(environmentId);
const channel = createStdioChannel(stream.readable, stream.writable);
const descriptor = {
  hostType: 'cli',
  pluginId: '@kb-labs/test-container-host-death',
  pluginVersion: '1.0.0',
  requestId: runId,
  handlerId: 'test:container-host-death',
  permissions: {},
  hostContext: { host: 'cli', binaryName: 'kb', argv: [], flags: {} },
};
const running = new Promise((resolve, reject) => {
  channel.on('log', (frame) => {
    if (frame.message.includes('container-host-death-running')) { resolve(); }
  });
  channel.onError(reject);
  channel.onClose(() => reject(new Error('Container stream closed before the fixture started')));
});
await channel.send({
  type: 'execution:start',
  requestId: runId,
  payload: {
    requestId: runId,
    descriptor,
    handlerPath: '/workspace/e2e/tests/fixtures/container-hanging-handler.mjs',
    input: {},
    cwd: '/workspace',
    strictFilesystemPermissions: false,
  },
});
await running;
process.stdout.write(`${JSON.stringify({ runId, environmentId, containerId: started.metadata?.containerId })}\n`);
