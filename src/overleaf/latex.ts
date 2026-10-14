/**
 * Lightweight LaTeX structure extraction.
 *
 * The point is to let the model navigate a paper without reading every file: a 40-page
 * thesis is far more than fits in a tool result, but its section skeleton plus the
 * \input graph is a few hundred tokens and answers "where does the related-work section
 * live and what file is it in".
 *
 * This is deliberately a scanner, not a parser. It has to be fast and total: it runs over
 * arbitrary user LaTeX, including files that do not compile, and must never throw.
 */

export interface OutlineEntry {
  /** sectioning depth: 0 = document/part, 1 = chapter, 2 = section, 3 = subsection, … */
  depth: number;
  kind: string;
  title: string;
  line: number;
}

export interface LatexSummary {
  outline: OutlineEntry[];
  labels: string[];
  citations: number;
  includes: string[];
  environments: Record<string, number>;
  wordCount: number;
  todos: string[];
}

const SECTIONING: Record<string, number> = {
  part: 1,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
};

/** Strip comments while respecting escaped percent signs (`\%`). */
export function stripComments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      for (let i = 0; i < line.length; i += 1) {
        if (line[i] !== '%') continue;
        let backslashes = 0;
        for (let j = i - 1; j >= 0 && line[j] === '\\'; j -= 1) backslashes += 1;
        if (backslashes % 2 === 0) return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

/** Read a braced argument starting at `open` (index of `{`), tolerating nesting. */
function readGroup(text: string, open: number): string | null {
  if (text[open] !== '{') return null;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

/** Best-effort plain text for a heading, dropping commands but keeping their arguments. */
function cleanTitle(raw: string): string {
  return raw
    .replace(/\\[a-zA-Z@]+\*?\s*/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

export function summarizeLatex(source: string): LatexSummary {
  const text = stripComments(source);
  const outline: OutlineEntry[] = [];
  const labels: string[] = [];
  const includes: string[] = [];
  const environments: Record<string, number> = {};
  const todos: string[] = [];
  let citations = 0;

  // Precompute line starts once; scanning by index then mapping to a line is O(n).
  const lineOf = buildLineIndex(text);

  const command = /\\([a-zA-Z@]+)(\*?)/g;
  let match: RegExpExecArray | null;
  while ((match = command.exec(text)) !== null) {
    const name = match[1] ?? '';
    const star = match[2] ?? '';
    const after = match.index + match[0].length;

    const depth = SECTIONING[name];
    if (depth !== undefined) {
      // Skip an optional *short title* argument: \section[short]{long}
      let cursor = after;
      while (cursor < text.length && /\s/.test(text[cursor] ?? '')) cursor += 1;
      if (text[cursor] === '[') {
        const close = text.indexOf(']', cursor);
        if (close !== -1) cursor = close + 1;
      }
      while (cursor < text.length && /\s/.test(text[cursor] ?? '')) cursor += 1;
      const title = readGroup(text, cursor);
      outline.push({
        depth,
        kind: `${name}${star}`,
        title: title === null ? '(untitled)' : cleanTitle(title),
        line: lineOf(match.index),
      });
      continue;
    }

    if (name === 'label' || name === 'input' || name === 'include' || name === 'subfile') {
      let cursor = after;
      while (cursor < text.length && /\s/.test(text[cursor] ?? '')) cursor += 1;
      const value = readGroup(text, cursor);
      if (value === null) continue;
      if (name === 'label') {
        if (labels.length < 500) labels.push(value.trim());
      } else {
        includes.push(value.trim());
      }
      continue;
    }

    if (name === 'cite' || name === 'citep' || name === 'citet' || name === 'autocite' ||
        name === 'parencite' || name === 'textcite' || name === 'footcite') {
      let cursor = after;
      while (cursor < text.length && /\s/.test(text[cursor] ?? '')) cursor += 1;
      if (text[cursor] === '[') {
        const close = text.indexOf(']', cursor);
        if (close !== -1) cursor = close + 1;
        while (cursor < text.length && /\s/.test(text[cursor] ?? '')) cursor += 1;
        if (text[cursor] === '[') {
          const close2 = text.indexOf(']', cursor);
          if (close2 !== -1) cursor = close2 + 1;
        }
      }
      const value = readGroup(text, cursor);
      if (value !== null) citations += value.split(',').filter((s) => s.trim()).length;
      continue;
    }

    if (name === 'begin') {
      let cursor = after;
      while (cursor < text.length && /\s/.test(text[cursor] ?? '')) cursor += 1;
      const env = readGroup(text, cursor);
      if (env !== null) {
        const key = env.trim();
        environments[key] = (environments[key] ?? 0) + 1;
      }
      continue;
    }

    if (name === 'todo' || name === 'TODO' || name === 'fixme' || name === 'FIXME') {
      let cursor = after;
      while (cursor < text.length && /\s/.test(text[cursor] ?? '')) cursor += 1;
      const value = readGroup(text, cursor);
      if (value !== null && todos.length < 100) {
        todos.push(`line ${lineOf(match.index)}: ${cleanTitle(value)}`);
      }
    }
  }

  const body = text
    .replace(/\\(begin|end)\{[^}]*\}/g, ' ')
    .replace(/\\[a-zA-Z@]+\*?(\[[^\]]*\])?/g, ' ')
    .replace(/[{}[\]$&_^~#%\\]/g, ' ');
  const wordCount = body.split(/\s+/).filter((w) => /[A-Za-z\u4e00-\u9fff]/.test(w)).length;

  return { outline, labels, citations, includes, environments, wordCount, todos };
}

function buildLineIndex(text: string): (index: number) => number {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return (index: number): number => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if ((starts[mid] ?? 0) <= index) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}

/** Render a summary as the compact text a tool returns. */
export function renderSummary(file: string, summary: LatexSummary): string {
  const lines: string[] = [`# ${file}`, `words: ~${summary.wordCount}`, ''];
  if (summary.outline.length > 0) {
    lines.push('Structure:');
    for (const entry of summary.outline) {
      lines.push(`${'  '.repeat(Math.max(0, entry.depth - 1))}- ${entry.kind} "${entry.title}" (line ${entry.line})`);
    }
    lines.push('');
  }
  if (summary.includes.length > 0) lines.push(`Inputs: ${summary.includes.join(', ')}`);
  const envKeys = Object.keys(summary.environments);
  if (envKeys.length > 0) {
    lines.push(`Environments: ${envKeys.map((k) => `${k}×${summary.environments[k]}`).join(', ')}`);
  }
  if (summary.labels.length > 0) lines.push(`Labels: ${summary.labels.slice(0, 40).join(', ')}${summary.labels.length > 40 ? ', …' : ''}`);
  if (summary.citations > 0) lines.push(`Citations: ${summary.citations}`);
  if (summary.todos.length > 0) {
    lines.push('', 'Todos:');
    for (const todo of summary.todos) lines.push(`- ${todo}`);
  }
  return lines.join('\n');
}