import { promises as fs } from 'node:fs';
import { createErrorEnvelope, ErrorEnvelopeError, type ErrorEnvelope } from '@kb-labs/core-platform';

export type SavedAuthFileFailure = 'invalid' | 'unreadable';

export class SavedAuthFileError extends ErrorEnvelopeError {
  constructor(readonly filePath: string, readonly reason: SavedAuthFileFailure) {
    super(createErrorEnvelope('KB_CONFIG_INVALID', {
      message: `Saved authentication file ${filePath} is ${reason}.`,
      hint: 'Run "kb auth login" to replace the saved authentication data, then retry the command.',
      details: { path: filePath },
    }));
    this.name = 'SavedAuthFileError';
    Object.setPrototypeOf(this, SavedAuthFileError.prototype);
  }
}

export function savedAuthFileErrorEnvelope(error: SavedAuthFileError): ErrorEnvelope {
  return error.envelope;
}

export async function readSavedAuthFile<T>(
  absolutePath: string,
  displayPath: string,
  isValid: (value: unknown) => value is T,
): Promise<T | null> {
  let raw: string;
  try {
    raw = await fs.readFile(absolutePath, 'utf-8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw new SavedAuthFileError(displayPath, 'unreadable');
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new SavedAuthFileError(displayPath, 'invalid');
  }
  if (!isValid(value)) throw new SavedAuthFileError(displayPath, 'invalid');
  return value;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

export function isSavedCredentialBase(value: unknown): value is {
  gatewayUrl: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.gatewayUrl !== 'string' || record.gatewayUrl.length === 0
    || typeof record.accessToken !== 'string' || record.accessToken.length === 0
    || typeof record.refreshToken !== 'string' || record.refreshToken.length === 0
    || typeof record.expiresAt !== 'number'
    || !Number.isFinite(record.expiresAt)) return false;
  try {
    const url = new URL(record.gatewayUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  } catch {
    return false;
  }
  return true;
}
