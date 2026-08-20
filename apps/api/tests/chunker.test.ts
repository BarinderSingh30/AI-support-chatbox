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

  it('never emits empty or whitespace-only chunks', () => {
    const chunks = chunkDocument('# A\n\n\n\n## B\n\n\n\nreal content here\n\n\n');
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.content.trim().length > 0)).toBe(true);
  });

  it('returns nothing for an empty document', () => {
    expect(chunkDocument('   \n\n  ')).toEqual([]);
  });
});
