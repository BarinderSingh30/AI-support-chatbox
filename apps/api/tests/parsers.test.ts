import { describe, expect, it } from 'vitest';
import { makePdf } from './helpers/make-pdf.ts';
import { parsePdf, parsePlainText, cleanText, contentHash } from '../src/modules/ingestion/parsers/index.ts';

describe('parsePdf', () => {
  it('extracts text and reports the page count', async () => {
    const pdf = makePdf(['Acme returns policy is thirty days.', 'Warranty lasts twenty four months.']);
    const parsed = await parsePdf(pdf);
    expect(parsed.pageCount).toBe(2);
    expect(parsed.text).toContain('thirty days');
    expect(parsed.text).toContain('twenty four months');
  });

  it('records where each page starts so chunks can cite a page number', async () => {
    const pdf = makePdf(['First page text.', 'Second page text.']);
    const parsed = await parsePdf(pdf);
    expect(parsed.pageBreaks).toHaveLength(2);
    expect(parsed.pageBreaks![0]).toBe(0);
    // Page 2 begins after page 1's text, so its offset lands on 'Second'.
    expect(parsed.text.slice(parsed.pageBreaks![1]!)).toContain('Second page text');
  });
});

describe('cleanText', () => {
  it('rejoins words hyphenated across a line break', () => {
    // Extremely common in PDFs, and it wrecks both keyword search and embeddings.
    expect(cleanText('The war-\nranty covers parts.')).toBe('The warranty covers parts.');
  });

  it('collapses runs of blank lines to a single paragraph break', () => {
    expect(cleanText('One\n\n\n\n\nTwo')).toBe('One\n\nTwo');
  });

  it('strips trailing spaces from lines', () => {
    expect(cleanText('One   \nTwo')).toBe('One\nTwo');
  });

it('normalizes non-breaking spaces to ordinary ones', () => {
    expect(cleanText('a\u00A0b')).toBe('a b');
  });
});

describe('contentHash', () => {
  it('is stable for identical content', () => {
    expect(contentHash('hello')).toBe(contentHash('hello'));
  });

  it('differs for different content', () => {
    expect(contentHash('hello')).not.toBe(contentHash('world'));
  });
});

describe('parsePlainText', () => {
  it('cleans the input and reports no pages', () => {
    const parsed = parsePlainText('Some   \ntext.');
    expect(parsed.text).toBe('Some\ntext.');
    expect(parsed.pageCount).toBeUndefined();
  });
});
