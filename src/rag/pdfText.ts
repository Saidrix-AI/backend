/**
 * Turns `pdftotext -layout` output of the lesson PDFs into the heading-marked
 * markdown that chunkFile splits on.
 *
 * The PDFs carry no markup, only typography that pdftotext flattens, so the
 * headings are recovered by shape: the first line is the title, a line that
 * reads "Module N …" is a module, and a short line standing alone between blank
 * lines with no sentence punctuation is a section heading. Table columns come
 * out as runs of spaces; they are joined with " | " so a row stays one line.
 */

const MAX_HEADING = 70;

function isHeadingShape(line: string): boolean {
  return (
    line.length > 0 &&
    line.length <= MAX_HEADING &&
    !/[.:;,?!]$/.test(line) &&
    !/^[•\-*\d]/.test(line) &&
    !line.includes(" | ")
  );
}

export function pdfTextToMarkdown(raw: string): string {
  const lines = raw
    .replace(/\f/g, "\n")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ""))
    // Page numbers: a line holding only a number, right-aligned by -layout.
    .filter((l) => !/^\s*\d{1,3}\s*$/.test(l))
    .map((l) => l.trim().replace(/\s{3,}/g, " | ").replace(/�/g, "–"));

  const out: string[] = [];
  let titled = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line) {
      out.push("");
      continue;
    }
    if (!titled) {
      out.push(`# ${line}`);
      titled = true;
      continue;
    }
    const alone = !lines[i - 1] && !lines[i + 1];
    if (/^Module \d+\b/.test(line) && line.length <= MAX_HEADING) out.push(`### ${line}`);
    else if (alone && isHeadingShape(line)) out.push(`## ${line}`);
    else out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The curriculum family a lesson PDF belongs to, from its file name. */
export function pdfCategory(fileName: string): { category: string; categoryNumber: number } {
  if (/-foundation-course\.pdf$/i.test(fileName)) return { category: "Programming Language Foundations", categoryNumber: 1 };
  if (/-course-roadmap\.pdf$/i.test(fileName)) return { category: "Career Roadmaps", categoryNumber: 2 };
  return { category: "Career Guides", categoryNumber: 3 };
}
