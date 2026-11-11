import { getCatalogEntry } from '@kb-labs/sdk/errors';
import type { PlatformErrorCode } from '@kb-labs/sdk/errors';

export function readSdkError(code: PlatformErrorCode) {
  return getCatalogEntry(code);
}
