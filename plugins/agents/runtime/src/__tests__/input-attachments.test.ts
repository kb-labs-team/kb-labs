import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareAgentAttachments } from '../input-attachments.js';

const { getDocumentMock } = vi.hoisted(() => ({ getDocumentMock: vi.fn() }));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ getDocument: getDocumentMock }));

function configurePdf(text: string): void {
  getDocumentMock.mockReturnValue({
    promise: Promise.resolve({
      numPages: 1,
      getPage: vi.fn(async () => ({
        getTextContent: async () => ({ items: text ? [{ str: text }] : [] }),
        cleanup: vi.fn(),
      })),
      destroy: vi.fn(),
    }),
    destroy: vi.fn(),
  });
}

describe('prepareAgentAttachments', () => {
  beforeEach(() => {
    getDocumentMock.mockReset();
  });

  it('prepares images as canonical vision parts with safe references', async () => {
    const prepared = await prepareAgentAttachments([{
      name: 'photo.png',
      mediaType: 'image/png',
      data: 'iVBORw0KGgo=',
    }]);

    expect(prepared.contentParts).toEqual([
      { type: 'text', text: 'Image attachment: photo.png' },
      { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' },
    ]);
    expect(prepared.requiredCapabilities).toEqual(['vision']);
    expect(prepared.references).toHaveLength(1);
    expect(prepared.references[0]).toMatchObject({ name: 'photo.png', mediaType: 'image/png', sizeBytes: 8 });
    expect(prepared.references[0]?.attachmentId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(prepared.files[0]?.bytes.toString('base64')).toBe('iVBORw0KGgo=');
    expect(JSON.stringify(prepared.references)).not.toContain('iVBOR');
  });

  it('extracts PDF text instead of pretending the model accepts raw PDF bytes', async () => {
    configurePdf('A useful paragraph from the PDF.');
    const prepared = await prepareAgentAttachments([{
      name: 'notes.pdf',
      mediaType: 'application/pdf',
      data: Buffer.from('%PDF-1.7 test').toString('base64'),
    }]);

    expect(prepared.contentParts).toEqual([{
      type: 'text',
      text: 'Attachment: notes.pdf\nPage 1\nA useful paragraph from the PDF.',
    }]);
    expect(prepared.requiredCapabilities).toEqual([]);
    expect(getDocumentMock).toHaveBeenCalledOnce();
  });

  it('returns a clear unsupported error for scanned PDFs without extractable text', async () => {
    configurePdf('');
    await expect(prepareAgentAttachments([{
      name: 'scan.pdf',
      mediaType: 'application/pdf',
      data: Buffer.from('%PDF-1.7 test').toString('base64'),
    }])).rejects.toMatchObject({
      code: 'AGENT_ATTACHMENT_PDF_NO_TEXT',
    });
  });

  it('rejects unsupported types, mismatched image signatures and invalid base64', async () => {
    await expect(prepareAgentAttachments([{
      name: 'vector.svg', mediaType: 'image/svg+xml', data: 'PHN2Zy8+',
    }])).rejects.toMatchObject({ code: 'AGENT_ATTACHMENT_UNSUPPORTED' });

    await expect(prepareAgentAttachments([{
      name: 'fake.png', mediaType: 'image/png', data: 'aGVsbG8=',
    }])).rejects.toMatchObject({ code: 'AGENT_ATTACHMENT_TYPE_MISMATCH' });

    await expect(prepareAgentAttachments([{
      name: 'bad.png', mediaType: 'image/png', data: 'not base64',
    }])).rejects.toMatchObject({ code: 'AGENT_ATTACHMENT_INVALID' });
  });
});
