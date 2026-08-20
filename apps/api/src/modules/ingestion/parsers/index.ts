import { createHash } from 'node:crypto';
import { extractText } from 'unpdf';

export interface ParsedDocument {
  text: string;
  pageCount?: number;
  /** Character offset into `text` where each page begins. */
  pageBreaks?: number[];
}

/**
 * Normalizes extracted text before chunking.
 *
 * The hyphenation rule matters more than it looks: PDF extraction routinely
 * yields "war-\nranty", which breaks keyword search outright and degrades the
 * embedding, and it is invisible when eyeballing the output.
 */
export function cleanText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[   ]/g, ' ')
    .replace(/(\w)-\n(\w)/g, '$1$2')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export async function parsePdf(data: Uint8Array): Promise<ParsedDocument> {
  const { totalPages, text: pages } = await extractText(data, { mergePages: false });

  const pageBreaks: number[] = [];
  const cleaned: string[] = [];
  let offset = 0;

  for (const page of pages) {
    const pageText = cleanText(page);
    pageBreaks.push(offset);
    cleaned.push(pageText);
    // +2 for the '\n\n' joining pages below.
    offset += pageText.length + 2;
  }

  return { text: cleaned.join('\n\n'), pageCount: totalPages, pageBreaks };
}

export function parsePlainText(raw: string): ParsedDocument {
  return { text: cleanText(raw) };
}

export function parseMarkdown(raw: string): ParsedDocument {
  // Markdown is fed through as-is: the chunker relies on its heading syntax.
  return { text: cleanText(raw) };
}

export type SourceType = 'pdf' | 'txt' | 'md' | 'paste';

export async function parseByType(
  sourceType: SourceType,
  payload: Uint8Array | string,
): Promise<ParsedDocument> {
  if (sourceType === 'pdf') {
    if (typeof payload === 'string') throw new Error('pdf parsing requires binary data');
    return parsePdf(payload);
  }
  const text = typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8');
  return sourceType === 'md' ? parseMarkdown(text) : parsePlainText(text);
}
