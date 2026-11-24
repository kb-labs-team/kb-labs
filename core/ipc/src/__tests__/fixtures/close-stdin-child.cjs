process.send('ready');
process.stdin.destroy();
setTimeout(() => {
  process.send('stdin-closed');
}, 50);
setTimeout(() => process.exit(0), 500);
