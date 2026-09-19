declare module 'gltf-validator' {
  export interface ValidationReport {
    issues: { numErrors: number; numWarnings: number; numInfos: number; numHints: number; messages: unknown[]; truncated?: boolean };
    [key: string]: unknown;
  }
  export function validateBytes(bytes: Uint8Array, options?: { uri?: string; format?: string; writeTimestamp?: boolean; maxIssues?: number }): Promise<ValidationReport>;
}
