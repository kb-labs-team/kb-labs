import { z } from 'zod';

const sourceIdSchema = z.union([z.literal('workspace'), z.string().regex(/^pkg-[a-z0-9-]{8,80}$/)]).optional();
const relativePathSchema = z.string().min(1).max(1024).refine((value) =>
  !value.startsWith('/') && !value.startsWith('\\') && !/^[A-Za-z]:/.test(value) && !value.split(/[\\/]/).includes('..'),
  'Path must stay inside the selected source',
);

export const viewerIndexQuerySchema = z.object({ source: sourceIdSchema, path: z.string().max(1024).optional() });
export const viewerSourcesQuerySchema = z.object({});
export const viewerFileQuerySchema = z.object({ source: sourceIdSchema, path: relativePathSchema });
export const viewerConvertQuerySchema = z.object({ source: sourceIdSchema, path: relativePathSchema.refine((value) => /\.(docx?)$/i.test(value), 'Path must name a DOC or DOCX file') });
export const viewerExportQuerySchema = z.object({ source: sourceIdSchema });
export const viewerImportBodySchema = z.object({
  fileName: z.string().regex(/^[^/\\]+\.zip$/i),
  data: z.string().min(1).regex(/^[A-Za-z0-9+/]*={0,2}$/).refine((value) => value.length % 4 !== 1),
});
