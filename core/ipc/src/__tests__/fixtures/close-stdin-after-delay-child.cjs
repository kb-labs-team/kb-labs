process.send('ready');
setTimeout(() => {
  process.stdin.destroy();
  process.send('stdin-closed');
}, 250);
setTimeout(() => process.exit(0), 700);
