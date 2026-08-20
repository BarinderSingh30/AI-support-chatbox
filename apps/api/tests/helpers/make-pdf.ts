/**
 * Builds a minimal valid PDF in memory so PDF tests need no binary fixture
 * committed to the repo.
 *
 * Text MUST be wrapped into lines that fit inside the MediaBox: pdf.js clips
 * anything drawn past the page edge, so a single long unwrapped line is
 * silently truncated at extraction time — which makes tests pass against
 * content that was never really there.
 */
const CHARS_PER_LINE = 80;
const LINES_PER_PAGE = 45;

function wrap(text: string): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && `${line} ${word}`.length > CHARS_PER_LINE) {
      lines.push(line);
      line = '';
    }
    line += (line ? ' ' : '') + word;
  }
  if (line) lines.push(line);
  return lines.slice(0, LINES_PER_PAGE);
}

const escape = (s: string) => s.replace(/[()\\]/g, '\\$&');

export function makePdf(pages: string[]): Uint8Array {
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  for (const [i, text] of pages.entries()) {
    const body = wrap(text)
      .map((l, n) => (n === 0 ? `(${escape(l)}) Tj` : `T* (${escape(l)}) Tj`))
      .join('\n');
    const stream = `BT /F1 11 Tf 14 TL 60 730 Td\n${body}\nET`;
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
    );
    objs.push(
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    );
  }

  let out = '%PDF-1.4\n';
  const offsets: number[] = [0];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) {
    out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}
