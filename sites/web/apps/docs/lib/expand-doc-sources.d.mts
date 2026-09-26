export type GeneratedDocSource = { source: string; examples: string[] };
export function renderGeneratedDocSource(command: string, generatedSources: Record<string, GeneratedDocSource>, match?: string): string;
export function syncDocSources(mdx: string, docPath?: string, generatedSources?: Record<string, GeneratedDocSource>): string;
