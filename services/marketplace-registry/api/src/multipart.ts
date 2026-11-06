import type { FastifyRequest } from 'fastify';

export interface MultipartResult {
  tarball: Buffer | null;
  fields: Record<string, string>;
}

/**
 * Parse a multipart/form-data request.
 * Expects a 'tarball' file field and arbitrary string fields.
 */
export async function parseMultipart(req: FastifyRequest): Promise<MultipartResult> {
  const parts = (req as any).parts?.() as AsyncIterable<any> | undefined;
  if (!parts) {
    return { tarball: null, fields: {} };
  }

  let tarball: Buffer | null = null;
  const fields: Record<string, string> = {};

  for await (const part of parts) {
    if (part.file) {
      if (part.fieldname === 'tarball') {
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) { chunks.push(chunk); }
        tarball = Buffer.concat(chunks);
      } else {
        // Drain unknown file fields
        for await (const _ of part.file) { /* noop */ }
      }
    } else {
      fields[part.fieldname] = part.value as string;
    }
  }

  return { tarball, fields };
}
