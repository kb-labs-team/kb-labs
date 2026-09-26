import { commandSources } from './doc-source-map.mjs';

export function renderGeneratedDocSource(command, generatedSources) {
  const source = commandSources[command];
  if (!source) {
    throw new Error(`Command "${command}" is not in the docs source allowlist`);
  }
  const generated = generatedSources?.[command];
  if (!generated || !Array.isArray(generated.examples) || generated.examples.length === 0) {
    throw new Error(`Generated source for "${command}" is missing or empty`);
  }
  if (generated.source !== source) {
    throw new Error(`Generated source for "${command}" points to unexpected path ${generated.source}`);
  }
  const title = `Generated from ${generated.source}`;
  return `\`\`\`bash title="${title}"\n${generated.examples.join('\n')}\n\`\`\``;
}

export function syncDocSources(mdx, docPath = '<MDX>', generatedSources) {
  return mdx.replace(/<CommandExamples\s+command="([^"]+)"\s*\/>/g, (_match, command) => {
    try {
      return renderGeneratedDocSource(command, generatedSources);
    } catch (error) {
      throw new Error(`${docPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
