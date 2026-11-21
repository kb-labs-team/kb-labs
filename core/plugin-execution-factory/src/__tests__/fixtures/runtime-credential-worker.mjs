if (process.env.KB_PROJECT_RUNTIME_TOKEN) {
  process.send({ type: 'workerError', message: 'runtime guard credential crossed worker boundary' });
} else {
  process.send({ type: 'ready', pid: process.pid });
}

process.on('message', (message) => {
  if (message.type === 'shutdown') { process.exit(0); }
});
