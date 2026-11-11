/**
 * Answer synthesis + frozen `AgentResponse` assembly.
 *
 * Produces the `agent-response-v1` contract consumed by CLAUDE.md and the
 * task-rag skill. The response is validated against the contract zod before
 * being returned, so a drift fails loudly here rather than silently downstream.
 */

import {
  AgentResponseSchema,
  type AgentResponse,
  type AgentSource,
  type AgentWarning,
  type AgentQueryMode,
  type SnippetMode,
} from '../../contracts/index.js';
import type { ILLM } from '../services';
import type { RankedChunk } from '../retrieval/retrieve';
import { snippetFrom } from './synthesize';

const MAX_SNIPPET_CHARS = 600;

function truncate(text: string): string {
  return text.length > MAX_SNIPPET_CHARS ? `${text.slice(0, MAX_SNIPPET_CHARS)}…` : text;
}

/** Extractive fallback answer (no LLM): the most relevant snippet, attributed. */
function extractiveAnswer(query: string, ranked: RankedChunk[]): string {
  if (ranked.length === 0) {
    return `No indexed content matched the query: "${query}".`;
  }
  const top = ranked[0]!.chunk;
  return `Most relevant source: ${top.path} (lines ${top.startLine}-${top.endLine}).\n\n${truncate(top.text)}`;
}

export async function synthesizeAnswer(
  query: string,
  ranked: RankedChunk[],
  llm: ILLM,
  useLLM: boolean,
): Promise<string> {
  if (!useLLM || ranked.length === 0) {
    return extractiveAnswer(query, ranked);
  }

  const context = ranked
    .map((r, i) => `[${i + 1}] ${r.chunk.path}:${r.chunk.startLine}-${r.chunk.endLine}\n${r.chunk.text}`)
    .join('\n\n');

  const prompt =
    `Answer the question using ONLY the provided context. Be concise and cite the ` +
    `relevant files by path. If the context does not contain the answer, say so.\n\n` +
    `Question: ${query}\n\nContext:\n${context}`;

  try {
    const { content } = await llm.complete(prompt, { temperature: 0.2, maxTokens: 800 });
    const trimmed = (content ?? '').trim();
    return trimmed.length > 0 ? trimmed : extractiveAnswer(query, ranked);
  } catch {
    return extractiveAnswer(query, ranked);
  }
}

export interface ToSourcesOptions {
  snippet: SnippetMode;
  staleByFile: Map<string, boolean>;
}

export function toSources(ranked: RankedChunk[], opts: ToSourcesOptions): AgentSource[] {
  return ranked.map(({ chunk, matchedBy }) => ({
    file: chunk.path,
    lines: [chunk.startLine, chunk.endLine] as [number, number],
    kind: chunk.kind,
    matchedBy,
    stale: opts.staleByFile.get(chunk.path) ?? false,
    snippet: snippetFrom(chunk.text, opts.snippet),
  }));
}

export interface BuildAgentResponseInput {
  answer: string;
  ranked: RankedChunk[];
  confidence: number;
  mode: AgentQueryMode;
  requestId: string;
  timingMs: number;
  indexId: string;
  floor: number;
  snippet: SnippetMode;
  staleByFile: Map<string, boolean>;
  warnings?: AgentWarning[];
}

/** Assemble + validate the lean agent response. */
export function buildAgentResponse(input: BuildAgentResponseInput): AgentResponse {
  const sources = toSources(input.ranked, { snippet: input.snippet, staleByFile: input.staleByFile });
  const abstained = input.confidence < input.floor || sources.length === 0;

  const response: AgentResponse = {
    answer: input.answer,
    confidence: input.confidence,
    abstained,
    sources,
    warnings: input.warnings && input.warnings.length > 0 ? input.warnings : undefined,
    meta: {
      requestId: input.requestId,
      mode: input.mode,
      timingMs: input.timingMs,
      indexId: input.indexId,
    },
  };

  // Fail loudly if we ever drift from the contract.
  return AgentResponseSchema.parse(response);
}
