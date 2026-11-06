import type { GeneratedDocSource, GeneratedSources } from '../lib/expand-doc-sources.mjs';

export type { GeneratedDocSource, GeneratedSources };
export function renderCommandExamples(command: string, generatedSources?: Record<string, GeneratedDocSource>, match?: string): string;
export function getDocsDir(): string;
export function collectGeneratedSources(): GeneratedSources;
