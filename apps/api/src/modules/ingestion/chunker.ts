export interface Chunk {
  index: number;
  content: string;
  headingPath: string | null;
  tokenCount: number;
  /** Offset of this chunk's own body in the source text (excludes overlap). */
  startOffset: number;
  endOffset: number;
}

export interface ChunkOptions {
  /** Target size. Well under gemini-embedding-001's 2048-token input limit. */
  maxTokens?: number;
  /** Fraction of a chunk repeated at the start of the next one. */
  overlapRatio?: number;
}

const DEFAULTS = { maxTokens: 600, overlapRatio: 0.15 };

/**
 * Approximate token count. Gemini's tokenizer is not available offline, and
 * calling countTokens per chunk would mean a network round trip per chunk during
 * ingestion. Four characters per token is the standard rule of thumb; our chunk
 * budget sits far enough below the model's input limit that the error is
 * harmless. If this ever needs to be exact, swap it here — nothing else depends
 * on the estimate.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*$/;

interface Unit {
  text: string;
  offset: number;
}

interface Section {
  headingPath: string | null;
  units: Unit[];
}

/** Split into sections keyed by their heading path, preserving document order. */
function toSections(text: string): Section[] {
  const stack: string[] = [];
  const sections: Section[] = [];
  let current: Section = { headingPath: null, units: [] };

  // Scan with offsets rather than split(), so every unit knows where it came
  // from — that is what lets a chunk be mapped back to a PDF page.
  const blockRe = /[^\n](?:[\s\S]*?)(?=\n\s*\n|$)/g;
  for (let m = blockRe.exec(text); m; m = blockRe.exec(text)) {
    const raw = m[0];
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const offset = m.index + raw.indexOf(trimmed);

    const heading = HEADING.exec(trimmed);
    if (heading) {
      if (current.units.length) sections.push(current);
      const depth = heading[1]!.length;
      // Popping to depth-1 is what makes a sibling heading replace its
      // predecessor rather than nest under it.
      stack.length = Math.min(stack.length, depth - 1);
      stack[depth - 1] = heading[2]!;
      current = { headingPath: stack.filter(Boolean).join(' > ') || null, units: [] };
      continue;
    }
    current.units.push({ text: trimmed, offset });
  }
  if (current.units.length) sections.push(current);
  return sections;
}

/** Break a unit that alone exceeds the budget, preferring sentence boundaries. */
function splitOversized(unit: string, maxTokens: number): string[] {
  const sentences = unit.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) ?? [unit];
  const out: string[] = [];
  let buf = '';

  for (const sentence of sentences) {
    if (estimateTokens(buf + sentence) > maxTokens && buf) {
      out.push(buf.trim());
      buf = '';
    }
    if (estimateTokens(sentence) > maxTokens) {
      // A single sentence over budget: fall back to word packing.
      const words = sentence.split(/\s+/);
      for (const word of words) {
        if (estimateTokens(`${buf} ${word}`) > maxTokens && buf) {
          out.push(buf.trim());
          buf = '';
        }
        buf += (buf ? ' ' : '') + word;
      }
      continue;
    }
    buf += sentence;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/**
 * Split a document into embeddable chunks.
 *
 * Splits on document structure first (markdown headings, then paragraphs, then
 * sentences) rather than on a fixed character count, so a chunk is a coherent
 * passage. Each chunk carries its heading path, which is what lets a citation
 * read "Billing > Refunds" instead of a bare page number.
 */
export function chunkDocument(text: string, options: ChunkOptions = {}): Chunk[] {
  const maxTokens = options.maxTokens ?? DEFAULTS.maxTokens;
  const overlapRatio = options.overlapRatio ?? DEFAULTS.overlapRatio;
  const overlapTokens = Math.floor(maxTokens * overlapRatio);

  const chunks: Chunk[] = [];
  let previousTail = '';

  for (const section of toSections(text)) {
    // Overlap never crosses a heading. It exists to rescue a fact split by the
    // token budget inside one section; bleeding a section into the next one
    // mislabels the chunk's heading, and headings are what citations show.
    previousTail = '';

    const units: Unit[] = section.units.flatMap((u) => {
      if (estimateTokens(u.text) <= maxTokens) return [u];
      // Sub-units keep the parent's offset as a floor; exact enough for pages.
      let cursor = u.offset;
      return splitOversized(u.text, maxTokens).map((piece) => {
        const at = u.text.indexOf(piece, cursor - u.offset);
        const offset = at >= 0 ? u.offset + at : cursor;
        cursor = offset + piece.length;
        return { text: piece, offset };
      });
    });

    let buf = '';
    let bufStart = -1;
    const flush = () => {
      const body = buf.trim();
      if (!body) return;
      const content = previousTail ? `${previousTail}\n\n${body}` : body;
      chunks.push({
        index: chunks.length,
        content,
        headingPath: section.headingPath,
        tokenCount: estimateTokens(content),
        startOffset: bufStart,
        endOffset: bufStart + body.length,
      });
      previousTail = overlapTokens > 0 ? tailWords(body, overlapTokens) : '';
      buf = '';
      bufStart = -1;
    };

    for (const unit of units) {
      if (buf && estimateTokens(`${buf}\n\n${unit.text}`) > maxTokens) flush();
      if (!buf) bufStart = unit.offset;
      buf += (buf ? '\n\n' : '') + unit.text;
    }
    flush();
  }

  return chunks;
}

/**
 * Trailing words of a chunk, roughly `tokens` worth, used as the next overlap.
 *
 * Capped at half the chunk: when the overlap budget exceeds the chunk's own
 * length — small sections against a large maxTokens — an uncapped tail returns
 * the entire chunk, so the next one duplicates it wholesale. That doubles
 * storage and embedding spend and makes retrieval return near-identical hits.
 */
function tailWords(text: string, tokens: number): string {
  const words = text.split(/\s+/);
  const budget = Math.min(tokens, Math.floor(estimateTokens(text) / 2));
  if (budget <= 0) return '';

  const out: string[] = [];
  for (let i = words.length - 1; i >= 0; i--) {
    out.unshift(words[i]!);
    if (estimateTokens(out.join(' ')) >= budget) break;
  }
  return out.join(' ');
}
