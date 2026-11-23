process.send({ type: 'ready', pid: process.pid });

process.on('message', (message) => {
  if (message.type === 'shutdown') { process.exit(0); }
  if (message.type !== 'execute') { return; }
  const requestId = message.requestId;
  const entry = (text) => ({ level: 'info', message: text, stream: 'stdout', lineNo: 0, timestamp: new Date().toISOString() });
  process.send({ type: 'log', requestId, entry: entry('prefix host-secret-') });
  process.send({ type: 'log', requestId, entry: entry('split\\r') });
  process.send({
    type: 'result', requestId,
    result: { ok: true, data: 'done', executionTimeMs: 1, metadata: { backend: 'worker-pool' } },
  });
});
