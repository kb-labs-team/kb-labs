import { createHash, randomBytes } from 'node:crypto';
import type { ICache } from '@kb-labs/core-platform';
import type { AuthContext } from '@kb-labs/gateway-contracts';

const CACHE_PREFIX = 'mcp:agent-lease:';
export const DEFAULT_AGENT_LEASE_TTL_SECONDS = 10 * 60;
export const MAX_AGENT_LEASE_TTL_SECONDS = 60 * 60;

export type LeaseScalar = string | number | boolean | null;

/** Exact input constraints can narrow a command to a particular resource. */
export type AgentLeaseInputConstraints = Record<string, Record<string, LeaseScalar>>;

export interface AgentLeaseRecord {
  version: 1;
  executionId: string;
  identity: AuthContext;
  allowedTools: string[];
  inputEquals: AgentLeaseInputConstraints;
  issuedAt: number;
  expiresAt: number;
  parentLeaseId?: string;
}

export interface IssueAgentLeaseInput {
  executionId: string;
  identity: AuthContext;
  allowedTools: string[];
  inputEquals?: AgentLeaseInputConstraints;
  ttlSeconds?: number;
  parent?: AgentLeaseRecord;
}

export class AgentLeaseError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'AgentLeaseError';
  }
}

function cacheKey(token: string): string {
  return `${CACHE_PREFIX}${createHash('sha256').update(token).digest('hex')}`;
}

function validateInputConstraints(
  constraints: unknown,
  allowedTools: Set<string>,
): void {
  if (constraints === null || typeof constraints !== 'object' || Array.isArray(constraints)) {
    throw new AgentLeaseError('inputEquals must be an object', 'LEASE_SCOPE_INVALID');
  }
  for (const [toolName, paths] of Object.entries(constraints)) {
    if (!allowedTools.has(toolName)) {
      throw new AgentLeaseError(`Input constraints reference a tool outside the lease: ${toolName}`, 'LEASE_SCOPE_INVALID');
    }
    if (paths === null || typeof paths !== 'object' || Array.isArray(paths)) {
      throw new AgentLeaseError(`Input constraints for ${toolName} must be an object`, 'LEASE_SCOPE_INVALID');
    }
    for (const [path, value] of Object.entries(paths)) {
      const segments = path.split('.');
      if (!path || segments.some((segment) => !segment || ['__proto__', 'prototype', 'constructor'].includes(segment))) {
        throw new AgentLeaseError(`Unsafe input constraint path: ${path}`, 'LEASE_SCOPE_INVALID');
      }
      if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
        throw new AgentLeaseError(`Input constraint for ${toolName}.${path} must be a JSON scalar`, 'LEASE_SCOPE_INVALID');
      }
    }
  }
}

function assertNarrowerThanParent(
  tools: Set<string>,
  constraints: AgentLeaseInputConstraints,
  parent: AgentLeaseRecord,
): void {
  const parentTools = new Set(parent.allowedTools);
  for (const tool of tools) {
    if (!parentTools.has(tool)) {
      throw new AgentLeaseError(`Child lease cannot add tool: ${tool}`, 'LEASE_ESCALATION');
    }
  }

  for (const tool of tools) {
    const parentConstraints = parent.inputEquals[tool] ?? {};
    const childConstraints = constraints[tool] ?? {};
    for (const [path, value] of Object.entries(parentConstraints)) {
      if (!Object.prototype.hasOwnProperty.call(childConstraints, path) || childConstraints[path] !== value) {
        throw new AgentLeaseError(`Child lease cannot widen input scope for ${tool}.${path}`, 'LEASE_ESCALATION');
      }
    }
  }
}

/** Create an opaque, short-lived, cache-backed lease. The raw bearer is never stored. */
export async function issueAgentLease(cache: ICache, input: IssueAgentLeaseInput): Promise<{ token: string; record: AgentLeaseRecord }> {
  const executionId = input.executionId.trim();
  if (!executionId || executionId.length > 160) {
    throw new AgentLeaseError('executionId must contain 1–160 characters', 'LEASE_SCOPE_INVALID');
  }

  const ttlSeconds = input.ttlSeconds ?? DEFAULT_AGENT_LEASE_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_AGENT_LEASE_TTL_SECONDS) {
    throw new AgentLeaseError(`ttlSeconds must be between 1 and ${MAX_AGENT_LEASE_TTL_SECONDS}`, 'LEASE_TTL_INVALID');
  }

  const allowedTools = [...new Set(input.allowedTools)];
  if (allowedTools.length === 0 || allowedTools.some((tool) => !tool || tool.length > 256)) {
    throw new AgentLeaseError('allowedTools must contain at least one valid tool name', 'LEASE_SCOPE_INVALID');
  }

  const inputEquals = input.inputEquals ?? {};
  const toolSet = new Set(allowedTools);
  validateInputConstraints(inputEquals, toolSet);
  if (input.parent) {
    assertNarrowerThanParent(toolSet, inputEquals, input.parent);
    if (input.parent.expiresAt <= Date.now()) {
      throw new AgentLeaseError('Parent lease has expired', 'LEASE_PARENT_EXPIRED');
    }
  }

  const issuedAt = Date.now();
  const expiresAt = Math.min(
    issuedAt + ttlSeconds * 1000,
    input.parent?.expiresAt ?? Number.POSITIVE_INFINITY,
  );
  const record: AgentLeaseRecord = {
    version: 1,
    executionId,
    identity: input.identity,
    allowedTools,
    inputEquals,
    issuedAt,
    expiresAt,
    ...(input.parent ? { parentLeaseId: input.parent.executionId } : {}),
  };
  const token = randomBytes(32).toString('base64url');
  await cache.set(cacheKey(token), record, expiresAt - issuedAt);
  return { token, record };
}

export async function resolveAgentLease(cache: ICache, token: string): Promise<AgentLeaseRecord | null> {
  if (!token || token.length > 256) { return null; }
  const record = await cache.get<AgentLeaseRecord>(cacheKey(token)).catch(() => null);
  if (!record || record.version !== 1 || record.expiresAt <= Date.now()) {
    if (record) { await cache.delete(cacheKey(token)).catch(() => {}); }
    return null;
  }
  return record;
}

export async function revokeAgentLease(cache: ICache, token: string): Promise<void> {
  if (!token || token.length > 256) { return; }
  await cache.delete(cacheKey(token));
}

function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Enforce the lease's tool allowlist and resource/input constraints. */
export function isAgentLeaseCallAllowed(
  lease: AgentLeaseRecord,
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (!lease.allowedTools.includes(toolName) || lease.expiresAt <= Date.now()) { return false; }
  const constraints = lease.inputEquals[toolName] ?? {};
  return Object.entries(constraints).every(([path, expected]) => readPath(input, path) === expected);
}
