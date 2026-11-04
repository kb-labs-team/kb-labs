import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildServiceTools, mcpToolName } from '../dist/project-module.js';
import { DEFAULT_PROJECT_MODULES } from '../../../project-runtime/app/dist/index.js';
import { manifest as commit } from '../../../../plugins/commit/dist/manifest.js';

const output = fileURLToPath(new URL('../../../../e2e/journey/generated/project_mcp_tool_names.json', import.meta.url));
const caseFile = fileURLToPath(new URL('../../../../docs/qa/scenarios/S-045-project-mcp-tools.md', import.meta.url));
const enabledManifests = DEFAULT_PROJECT_MODULES.map((module) => module.manifest);
const serviceTools = buildServiceTools(enabledManifests);
const generated = `${JSON.stringify({
  enabledServices: enabledManifests.map((manifest) => manifest.id),
  servicePrefixes: Object.fromEntries(enabledManifests.map((manifest) => [manifest.id, mcpToolName(manifest.id, '')])),
  services: Object.fromEntries(enabledManifests.map((manifest) => [
    manifest.id,
    Object.fromEntries(
      (manifest.commands ?? []).filter((command) => command.route).map((command, index) => [
        command.name,
        serviceTools.filter((tool) => tool.serviceId === manifest.id)[index].name,
      ]),
    ),
  ])),
  commit: Object.fromEntries((commit.cli?.commands ?? []).map((command) => [command.path, mcpToolName(commit.id, command.path)])),
}, null, 2)}\n`;

const catalog = JSON.parse(generated);
const servicePrefixes = Object.keys(catalog.services).map((serviceId) => `${serviceId}__`);
const generatedServiceNames = new Set(Object.values(catalog.services).flatMap((commands) => Object.values(commands)));
const caseRows = (await readFile(caseFile, 'utf8')).split('\n');
const caseRow = caseRows.find((line) => line.startsWith('| S-045.2 |'));
const caseServiceNames = caseRow?.split('|')[3].split('`').filter((token) => servicePrefixes.some((prefix) => token.startsWith(prefix))) ?? [];
if (caseServiceNames.length === 0 || caseServiceNames.some((name) => !generatedServiceNames.has(name))) {
  process.stderr.write('S-045.2 service tool name does not match the generated MCP catalog.\n');
  process.exitCode = 1;
}

if (process.argv.includes('--check')) {
  const current = await readFile(output, 'utf8');
  if (current !== generated) {
    process.stderr.write('Generated MCP journey tool names are stale. Run the generator after building MCP, project runtime, workflow daemon, and Commit.\n');
    process.exitCode = 1;
  }
} else {
  await writeFile(output, generated);
}
