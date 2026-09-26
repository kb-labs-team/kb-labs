export type GeneratedDocSource = { source: string; examples: string[] };
export function renderCommandExamples(command: string, generatedSources?: Record<string, GeneratedDocSource>, match?: string): string;
export function getDocsDir(): string;
export function sourceFileForCommand(command: string): string | undefined;
export function collectGeneratedSources(): Record<string, GeneratedDocSource>;
