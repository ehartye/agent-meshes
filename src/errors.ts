import { z } from 'zod';

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
    ...(issues ? { issues } : {}),
    ...(typeof value.expected === 'number' ? { expected: value.expected } : {}),
    ...(typeof value.actual === 'number' ? { actual: value.actual } : {}),
  };
}
