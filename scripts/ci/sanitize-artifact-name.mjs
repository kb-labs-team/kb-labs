import { pathToFileURL } from 'node:url';

export function sanitizeArtifactComponent(value) {
  return String(value)
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

export function journeyArtifactName(os, scenario) {
  return `service-journey-results-${sanitizeArtifactComponent(os)}-${sanitizeArtifactComponent(scenario)}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [os, scenario] = process.argv.slice(2);
  if (!os || !scenario) {
    process.stderr.write('Expected matrix OS and scenario values.\n');
    process.exitCode = 2;
  } else {
    process.stdout.write(`${journeyArtifactName(os, scenario)}\n`);
  }
}

