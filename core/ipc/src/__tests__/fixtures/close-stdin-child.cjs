process.stdin.destroy();
process.stdout.write('ready\n');
setTimeout(() => process.exit(0), 500);
