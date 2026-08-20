import { describe, expect, it } from 'vitest';
import { chunkDocument } from '../src/modules/ingestion/chunker.ts';
import { assignPages } from '../src/modules/ingestion/pages.ts';

describe('chunk offsets', () => {
  it('reports where each chunk body starts in the source text', () => {
    const text = '# A\n\nAlpha paragraph.\n\nBeta paragraph.';
    const chunks = chunkDocument(text, { maxTokens: 6, overlapRatio: 0 });
    for (const chunk of chunks) {
      expect(text.slice(chunk.startOffset, chunk.startOffset + 5))
        .toBe(chunk.content.slice(0, 5));
    }
  });

  it('reports offsets that increase monotonically', () => {
    const text = Array.from({ length: 20 }, (_, i) => `Para ${i} text here.`).join('\n\n');
    const chunks = chunkDocument(text, { maxTokens: 20, overlapRatio: 0 });
    const offsets = chunks.map((c) => c.startOffset);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
  });
});

describe('assignPages', () => {
  const breaks = [0, 100, 250]; // three pages

  it('maps an offset inside page one to page one', () => {
    const [c] = assignPages([{ startOffset: 10, endOffset: 50 }], breaks);
    expect(c).toEqual({ pageFrom: 1, pageTo: 1 });
  });

  it('maps an offset inside the last page', () => {
    const [c] = assignPages([{ startOffset: 260, endOffset: 300 }], breaks);
    expect(c).toEqual({ pageFrom: 3, pageTo: 3 });
  });

  it('spans pages when a chunk crosses a page boundary', () => {
    const [c] = assignPages([{ startOffset: 90, endOffset: 260 }], breaks);
    expect(c).toEqual({ pageFrom: 1, pageTo: 3 });
  });

  it('returns nulls when the document has no pages', () => {
    const [c] = assignPages([{ startOffset: 0, endOffset: 10 }], undefined);
    expect(c).toEqual({ pageFrom: null, pageTo: null });
  });
});
