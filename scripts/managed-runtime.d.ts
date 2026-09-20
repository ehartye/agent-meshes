export interface RuntimeSource { source: string; name: string; version: string; fingerprint: string; key: string; files: string[] }
export interface Runtime extends RuntimeSource { home: string; root: string; cli: string }
export interface InstallOptions {
  home?: string;
  npm?: (args: string[], options: { cwd: string; progress?: boolean }) => string;
  checkDependencies?: (root: string) => void;
  installBrowser?: (root: string) => void;
}
export interface InstallationReport {
  ok: boolean; pluginVersion: string; cliVersion: string | null; runtimeRoot: string; fingerprint: string;
  linked: boolean; dependencies: boolean; errors: string[]; linkedRoot?: string | null; pathDirectory?: string; pathConfigured?: boolean; pathHint?: string;
}
export function managedHome(): string;
export function describeSource(source: string): RuntimeSource;
export function resolveRuntime(source: string, options?: { home?: string }): Runtime;
export function runNpm(args: string[], options?: { cwd?: string; progress?: boolean }): string;
export function installBrowser(root: string): void;
export function checkDependencies(root: string): void;
export function findBlenderFrom(root: string): string | null;
export function installRuntime(source: string, options?: InstallOptions): Runtime;
export function inspectInstallation(source: string, options?: Omit<InstallOptions, 'installBrowser'>): InstallationReport;
