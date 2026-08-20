export interface OffsetSpan {
  startOffset: number;
  endOffset: number;
}

export interface PageSpan {
  pageFrom: number | null;
  pageTo: number | null;
}

/** 1-based page containing `offset`, given each page's starting offset. */
function pageAt(offset: number, pageBreaks: number[]): number {
  let page = 1;
  for (let i = 0; i < pageBreaks.length; i++) {
    if (offset >= pageBreaks[i]!) page = i + 1;
    else break;
  }
  return page;
}

/**
 * Maps chunk character offsets onto page numbers so a citation can say "p. 4".
 * Plain text and pasted content have no pages, hence the nulls.
 */
export function assignPages(spans: OffsetSpan[], pageBreaks?: number[]): PageSpan[] {
  if (!pageBreaks?.length) {
    return spans.map(() => ({ pageFrom: null, pageTo: null }));
  }
  return spans.map((span) => ({
    pageFrom: pageAt(span.startOffset, pageBreaks),
    pageTo: pageAt(span.endOffset, pageBreaks),
  }));
}
