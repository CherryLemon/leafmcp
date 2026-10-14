/** Errors that are safe and useful to show the model verbatim. */
export class ToolError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'ToolError';
    this.hint = hint;
  }

  /** Rendered into the tool result so the model can self-correct instead of giving up. */
  toModelMessage(): string {
    return this.hint ? `${this.message}\nHint: ${this.hint}` : this.message;
  }
}

const SECRET_WORDS =
  'cookie|session|token|password|authorization|secret|apikey|api_key|client_secret';
const SECRET_ASSIGNMENT = new RegExp(
  `(["']?(?:${SECRET_WORDS})["']?\\s*[:=]\\s*)(["']?)([^\\s,;"'}]{4,})`,
  'gi',
);

/**
 * Literal values to scrub wherever they appear.
 *
 * The pattern-based rules above only catch `name=value` shapes, so a credential echoed on
 * its own — in a stack trace, a URL, a dependency's error string — would slip through.
 * Registering the actual configured secrets closes that gap regardless of how they surface.
 */
const literalSecrets: string[] = [];

export function registerSecret(value: string | undefined | null): void {
  // Short values would redact unrelated text; real credentials are long.
  if (typeof value !== 'string' || value.length < 8) return;
  if (!literalSecrets.includes(value)) literalSecrets.push(value);
}

/**
 * Strip credentials before anything reaches a log line or a tool result.
 * The Overleaf session cookie is a full-account bearer credential — it must never
 * appear in model-visible text, since that text is sent to a third-party model.
 */
export function redact(input: unknown): string {
  let text: string;
  if (typeof input === 'string') text = input;
  else if (input instanceof Error) text = input.stack ?? input.message;
  else {
    try {
      text = JSON.stringify(input);
    } catch {
      text = String(input);
    }
  }
  let scrubbed = text
    .replace(/(overleaf_session2|sharelatex\.sid|connect\.sid)=[^;\s"']+/gi, '$1=<redacted>')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1<redacted>')
    .replace(SECRET_ASSIGNMENT, '$1$2<redacted>');

  for (const secret of literalSecrets) {
    scrubbed = scrubbed.split(secret).join('<redacted>');
  }
  return scrubbed;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : String(error);
}