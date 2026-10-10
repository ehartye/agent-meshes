import { z } from 'zod';

/**
 * A validation failure that knows which field and value caused it and how to fix the most common mistake.
 * `path` is relative to the thing being validated (a part's geometry, for example `geometry.outline[2]`).
 */
export class ModelError extends Error {
  /** The failure without part name or hint, for callers that add their own context. */
  readonly summary: string;
  readonly path?: string;
  readonly value?: unknown;
  readonly hint?: string;
  readonly part?: string;
  constructor(summary: string, detail: { path?: string; value?: unknown; hint?: string; part?: string } = {}) {
    super(`${detail.part ? `Part "${detail.part}": ` : ''}${summary}${detail.hint ? ` Hint: ${detail.hint}` : ''}`);
    this.name = 'ModelError';
    this.summary = summary; this.path = detail.path; this.value = detail.value; this.hint = detail.hint; this.part = detail.part;
  }
  /** The same failure attributed to a named part. */
  forPart(part: string): ModelError { return new ModelError(this.summary, { path: this.path, value: this.value, hint: this.hint, part }); }
}

/** One machine-readable error shape for native commands and HTTP transport. */
export function errorDetails(error: unknown) {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const code = typeof value.code === 'string' ? (value.code.startsWith('commander.') ? 'CLI_ARGUMENT_ERROR' : value.code)
    : error instanceof z.ZodError ? 'VALIDATION_ERROR'
    : error instanceof SyntaxError ? 'INVALID_JSON'
    : typeof value.operationIndex === 'number' ? 'OPERATION_FAILED' : 'AUTHORING_ERROR';
  const issues = error instanceof z.ZodError ? error.issues : Array.isArray(value.issues) ? value.issues : undefined;
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    ...(typeof value.operationIndex === 'number' ? { operationIndex: value.operationIndex } : {}),
    ...(typeof value.op === 'string' ? { op: value.op } : {}),
    ...(typeof value.part === 'string' ? { part: value.part } : {}),
    ...(typeof value.field === 'string' ? { field: value.field } : {}),
    ...(value.value !== undefined ? { value: value.value } : {}),
    ...(typeof value.hint === 'string' ? { hint: value.hint } : {}),
    ...(issues ? { issues } : {}),
    ...(typeof value.expected === 'number' ? { expected: value.expected } : {}),
    ...(typeof value.actual === 'number' ? { actual: value.actual } : {}),
  };
}
