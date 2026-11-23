process.send('ready', () => {
  setTimeout(() => process.disconnect(), 25);
});
