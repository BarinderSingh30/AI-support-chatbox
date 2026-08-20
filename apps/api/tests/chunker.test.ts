import { describe, expect, it } from 'vitest';
import { chunkDocument } from '../src/modules/ingestion/chunker.ts';

describe('chunkDocument', () => {
  it('returns a single chunk for a short document', () => {
    const chunks = chunkDocument('Acme accepts returns within 30 days.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toContain('30 days');
  });

  it('numbers chunks sequentially from zero', () => {
    const text = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} with some filler words.`).join('\n\n');
    const chunks = chunkDocument(text, { maxTokens: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it('records the heading path so citations can name the section', () => {
    const text = [
      '# Billing',
      '## Refunds',
      'Refunds are issued within 14 days.',
    ].join('\n\n');
    const chunks = chunkDocument(text);
    expect(chunks[0]?.headingPath).toBe('Billing > Refunds');
  });

  it('drops back to the parent heading when a section ends', () => {
    const text = [
      '# Billing',
      '## Refunds',
      'Refunds text.',
      '## Invoices',
      'Invoice text.',
    ].join('\n\n');
    const chunks = chunkDocument(text);
    const invoice = chunks.find((c) => c.content.includes('Invoice text'));
    expect(invoice?.headingPath).toBe('Billing > Invoices');
  });

  it('splits a section that exceeds the token budget', () => {
    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} about warranty coverage.`).join(' ');
    const chunks = chunkDocument(`# Warranty\n\n${long}`, { maxTokens: 40 });
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk keeps the heading, so a citation from any of them still reads well.
    expect(chunks.every((c) => c.headingPath === 'Warranty')).toBe(true);
  });

  it('overlaps consecutive chunks so a fact split across a boundary survives', () => {
    const paras = Array.from({ length: 30 }, (_, i) => `Fact ${i} is important.`).join('\n\n');
    const chunks = chunkDocument(paras, { maxTokens: 40, overlapRatio: 0.2 });
    expect(chunks.length).toBeGreaterThan(1);
    const first = chunks[0]!.content;
    const second = chunks[1]!.content;
    const tail = first.trim().split(/\s+/).slice(-4).join(' ');
    expect(second).toContain(tail);
  });

  it('does not carry overlap across a heading boundary', () => {
    // Overlap exists to save a fact split by the token budget mid-section.
    // Bleeding one section into the next mislabels the chunk's heading, which
    // is what citations are rendered from — a citation that names the wrong
    // section is worse than no citation.
    const text = [
      '# Warranty', 'Warranty text about coverage and duration.',
      '# Shipping', 'Shipping text about delivery and cost.',
    ].join('\n\n');
    const chunks = chunkDocument(text);
    const shipping = chunks.find((c) => c.headingPath === 'Shipping');
    expect(shipping?.content).not.toContain('Warranty text');
  });

  it('caps overlap so a short chunk is never duplicated wholesale', () => {
    // With a large overlap budget and small paragraphs, a naive tail-grab
    // returns the entire previous chunk and doubles both storage and cost.
    const text = Array.from({ length: 8 }, (_, i) => `Paragraph ${i} is quite short.`).join('\n\n');
    const chunks = chunkDocument(text, { maxTokens: 12, overlapRatio: 0.9 });
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.content).not.toContain(chunks[i - 1]!.content);
    }
  });

  it('never emits empty or whitespace-only chunks', () => {
    const chunks = chunkDocument('# A\n\n\n\n## B\n\n\n\nreal content here\n\n\n');
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.content.trim().length > 0)).toBe(true);
  });

  it('returns nothing for an empty document', () => {
    expect(chunkDocument('   \n\n  ')).toEqual([]);
  });
});
