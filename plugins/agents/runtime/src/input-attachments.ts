import type {
  AgentAttachmentReference,
  AgentAttachmentUpload,
} from '@kb-labs/agent-contracts';
import type { LLMCapability, LLMContentPart } from '@kb-labs/sdk';
import { validateLLMContent } from '@kb-labs/sdk';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { randomUUID } from 'node:crypto';

const MAX_ATTACHMENT_COUNT = 10;
const MAX_ATTACHMENT_BYTES = 7 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 7 * 1024 * 1024;
const MAX_PDF_PAGES = 100;
const MAX_EXTRACTED_TEXT_CHARS = 200_000;
const IMAGE_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

export class AgentAttachmentError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'AgentAttachmentError';
    this.code = code;
  }
}

export interface PreparedAgentAttachments {
  contentParts: LLMContentPart[];
  references: AgentAttachmentReference[];
  files: Array<{ attachmentId: string; bytes: Buffer; mediaType: string }>;
  requiredCapabilities: LLMCapability[];
}

/** Convert request uploads into the canonical LLM content-part contract. */
export async function prepareAgentAttachments(
  attachments: AgentAttachmentUpload[] | undefined,
): Promise<PreparedAgentAttachments> {
  if (attachments !== undefined && !Array.isArray(attachments)) {
    throw new AgentAttachmentError('AGENT_ATTACHMENT_INVALID', 'Attachments must be an array.');
  }
  if (!attachments?.length) {
    return { contentParts: [], references: [], files: [], requiredCapabilities: [] };
  }
  if (attachments.length > MAX_ATTACHMENT_COUNT) {
    throw new AgentAttachmentError('AGENT_ATTACHMENT_COUNT_EXCEEDED', `At most ${MAX_ATTACHMENT_COUNT} files can be attached to one run.`);
  }

  let totalBytes = 0;
  const contentParts: LLMContentPart[] = [];
  const references: AgentAttachmentReference[] = [];
  const files: PreparedAgentAttachments['files'] = [];

  for (const attachment of attachments) {
    validateUploadShape(attachment);
    const bytes = decodeBase64(attachment.data);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new AgentAttachmentError('AGENT_ATTACHMENT_SIZE_INVALID', `${attachment.name} must be between 1 byte and 7 MiB.`);
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new AgentAttachmentError('AGENT_ATTACHMENT_TOTAL_SIZE_EXCEEDED', 'Attachments must total no more than 7 MiB per run (including base64-encoded REST upload overhead).');
    }

    const attachmentId = randomUUID();
    references.push({ attachmentId, name: attachment.name, mediaType: attachment.mediaType, sizeBytes: bytes.byteLength });
    files.push({ attachmentId, bytes, mediaType: attachment.mediaType });
    if (IMAGE_MEDIA_TYPES.has(attachment.mediaType)) {
      validateImageSignature(bytes, attachment.mediaType, attachment.name);
      contentParts.push({ type: 'text', text: `Image attachment: ${attachment.name}` });
      contentParts.push({
        type: 'image',
        mediaType: attachment.mediaType as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
        data: bytes.toString('base64'),
      });
      continue;
    }

    if (attachment.mediaType === 'application/pdf') {
      validatePdfSignature(bytes, attachment.name);
      const text = await extractPdfText(bytes, attachment.name);
      contentParts.push({ type: 'text', text: `Attachment: ${attachment.name}\n${text}` });
      continue;
    }

    throw new AgentAttachmentError('AGENT_ATTACHMENT_UNSUPPORTED', `${attachment.name} has unsupported media type "${attachment.mediaType}". Supported types are PDF, JPEG, PNG, WebP, and GIF.`);
  }

  const validated = contentParts.length > 0
    ? validateLLMContent('user', contentParts)
    : { content: contentParts, requiredCapabilities: [] };
  return {
    contentParts,
    references,
    files,
    requiredCapabilities: validated.requiredCapabilities,
  };
}

function validateUploadShape(value: AgentAttachmentUpload): void {
  if (!value || typeof value !== 'object'
    || typeof value.name !== 'string' || !value.name.trim()
    || typeof value.mediaType !== 'string'
    || typeof value.data !== 'string') {
    throw new AgentAttachmentError('AGENT_ATTACHMENT_INVALID', 'Each attachment must include a name, mediaType, and base64 data.');
  }
  if (value.name.length > 255 || /[\\/\u0000-\u001f]/.test(value.name)) {
    throw new AgentAttachmentError('AGENT_ATTACHMENT_INVALID', 'Attachment names must be plain filenames up to 255 characters.');
  }
}

function decodeBase64(data: string): Buffer {
  if (data.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4
    || data.length === 0
    || data.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    throw new AgentAttachmentError('AGENT_ATTACHMENT_INVALID', 'Attachment data must be valid standard base64.');
  }
  return Buffer.from(data, 'base64');
}

function validateImageSignature(bytes: Buffer, mediaType: string, name: string): void {
  const signatures: Record<string, (buffer: Buffer) => boolean> = {
    'image/png': (buffer) => buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    'image/jpeg': (buffer) => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
    'image/gif': (buffer) => buffer.subarray(0, 6).toString('ascii').match(/^GIF8[79]a$/) !== null,
    'image/webp': (buffer) => buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP',
  };
  if (!signatures[mediaType]?.(bytes)) {
    throw new AgentAttachmentError('AGENT_ATTACHMENT_TYPE_MISMATCH', `${name} does not contain valid ${mediaType} data.`);
  }
}

function validatePdfSignature(bytes: Buffer, name: string): void {
  if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new AgentAttachmentError('AGENT_ATTACHMENT_TYPE_MISMATCH', `${name} does not contain valid PDF data.`);
  }
}

async function extractPdfText(bytes: Buffer, name: string): Promise<string> {
  const loadingTask = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  let pdf: Awaited<typeof loadingTask.promise> | undefined;
  try {
    pdf = await loadingTask.promise;
    if (pdf.numPages > MAX_PDF_PAGES) {
      throw new AgentAttachmentError('AGENT_ATTACHMENT_PDF_PAGE_LIMIT', `${name} has ${pdf.numPages} pages; the limit is ${MAX_PDF_PAGES}.`);
    }
    const pages: string[] = [];
    let chars = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => 'str' in item ? item.str : '')
        .filter(Boolean)
        .join(' ')
        .trim();
      if (pageText) {
        pages.push(`Page ${pageNumber}\n${pageText}`);
        chars += pageText.length;
        if (chars > MAX_EXTRACTED_TEXT_CHARS) {
          throw new AgentAttachmentError('AGENT_ATTACHMENT_PDF_TEXT_LIMIT', `${name} contains too much extractable text (limit: ${MAX_EXTRACTED_TEXT_CHARS} characters).`);
        }
      }
      page.cleanup();
    }
    const text = pages.join('\n\n');
    if (!text) {
      throw new AgentAttachmentError('AGENT_ATTACHMENT_PDF_NO_TEXT', `${name} has no extractable text. Scanned PDFs are not supported yet; attach the relevant pages as images.`);
    }
    return text;
  } catch (error) {
    if (error instanceof AgentAttachmentError) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new AgentAttachmentError('AGENT_ATTACHMENT_PDF_INVALID', `Could not read ${name}: ${detail}`);
  } finally {
    await loadingTask.destroy();
  }
}
