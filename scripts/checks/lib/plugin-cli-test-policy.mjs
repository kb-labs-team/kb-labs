export function validatePluginCliTestPolicy(packageName, packageJson, manifest) {
  const hasCommands = (manifest.cli?.commands?.length ?? 0) > 0;
  const testCommand = packageJson.scripts?.['test:cli'];

  if (hasCommands && (typeof testCommand !== 'string' || testCommand.trim() === '')) {
    return [{
      severity: 'error',
      package: packageName,
      file: `${packageName}/package.json`,
      message: 'manifest declares CLI commands but package.json has no non-empty test:cli script',
    }];
  }
  if (!hasCommands && testCommand !== undefined) {
    return [{
      severity: 'error',
      package: packageName,
      file: `${packageName}/package.json`,
      message: 'manifest declares no CLI commands but package.json contains a test:cli script',
    }];
  }
  return [];
}
