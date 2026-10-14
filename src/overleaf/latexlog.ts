/**
 * Turn a raw LaTeX log into something worth putting in a tool result.
 *
 * A real thesis log is thousands of lines of which perhaps twenty matter. Handing the model
 * the whole thing wastes its context and buries the actual error, so errors are extracted
 * with their `l.NN` line reference and the noise is counted rather than listed.
 */

export interface LatexLogSummary {
  /** False when LaTeX reported at least one hard error. */
  ok: boolean;
  errors: string[];
  warnings: string[];
  overfull: number;
  underfull: number;
  missingReferences: string[];
  pages?: number;
  outputFile?: string;
}

export function parseLatexLog(raw: string): LatexLogSummary {
  const lines = raw.split(/\r?\n/);
  const errors: string[] = [];
  const warnings: string[] = [];
  const missingReferences: string[] = [];
  let overfull = 0;
  let underfull = 0;
  let pages: number | undefined;
  let outputFile: string | undefined;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';

    if (line.startsWith('!')) {
      // LaTeX prints the offending source line after `l.<number>`; keep them together
      // because "Undefined control sequence" alone rarely identifies the mistake.
      let context = '';
      for (let j = i + 1; j < Math.min(i + 12, lines.length); j += 1) {
        const candidate = lines[j] ?? '';
        const match = /^l\.(\d+)\s?(.*)$/.exec(candidate);
        if (match) {
          context = ` (line ${match[1]}${match[2] ? `: ${match[2].trim().slice(0, 120)}` : ''})`;
          break;
        }
      }
      errors.push(`${line.trim().slice(0, 300)}${context}`);
      continue;
    }

    if (/^(LaTeX|Package|Class) .*Warning:/.test(line)) {
      const text = line.trim();
      if (/Reference .* undefined/.test(text) || /Citation .* undefined/.test(text)) {
        if (missingReferences.length < 25) missingReferences.push(text.slice(0, 200));
      } else if (warnings.length < 40) {
        warnings.push(text.slice(0, 200));
      }
      continue;
    }

    if (line.startsWith('Overfull \\hbox')) overfull += 1;
    else if (line.startsWith('Underfull \\hbox')) underfull += 1;

    const output = /^Output written on (.+?) \((\d+) pages?/.exec(line);
    if (output) {
      outputFile = output[1];
      pages = Number.parseInt(output[2] ?? '', 10);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    overfull,
    underfull,
    missingReferences,
    pages,
    outputFile,
  };
}

export function renderLogSummary(summary: LatexLogSummary, opts: { maxErrors?: number; maxWarnings?: number } = {}): string {
  const maxErrors = opts.maxErrors ?? 20;
  const maxWarnings = opts.maxWarnings ?? 12;
  const out: string[] = [];

  if (summary.ok) {
    out.push(
      summary.pages !== undefined
        ? `Compiled successfully — ${summary.pages} page(s).`
        : 'Compiled successfully (no errors reported).',
    );
  } else {
    out.push(`${summary.errors.length} error(s):`);
    for (const error of summary.errors.slice(0, maxErrors)) out.push(`  ${error}`);
    if (summary.errors.length > maxErrors) {
      out.push(`  … and ${summary.errors.length - maxErrors} more error(s)`);
    }
  }

  if (summary.missingReferences.length > 0) {
    out.push('', `Undefined references/citations (${summary.missingReferences.length}):`);
    for (const item of summary.missingReferences.slice(0, 10)) out.push(`  ${item}`);
    if (summary.missingReferences.length > 10) {
      out.push(`  … and ${summary.missingReferences.length - 10} more`);
    }
  }

  if (summary.warnings.length > 0) {
    out.push('', `Warnings (${summary.warnings.length}):`);
    for (const warning of summary.warnings.slice(0, maxWarnings)) out.push(`  ${warning}`);
    if (summary.warnings.length > maxWarnings) {
      out.push(`  … and ${summary.warnings.length - maxWarnings} more`);
    }
  }

  if (summary.overfull > 0 || summary.underfull > 0) {
    out.push('', `Box warnings: ${summary.overfull} overfull, ${summary.underfull} underfull.`);
  }

  return out.join('\n');
}