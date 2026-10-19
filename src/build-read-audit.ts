import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

const path = z.string().min(1).max(32768);
const observationSchema = z.object({ schema: z.literal(1), installed: z.boolean(), reads: z.array(path).max(20000), runtimeRoots: z.array(path).max(8), unresolvedEvents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), truncated: z.boolean() }).strict();
export const readAuditSchema = z.object({
  schema: z.literal(1), coverage: z.literal('python-open-attempts-and-modules'), scope: z.enum(['config-directory', 'project-root']),
  status: z.enum(['clean', 'undeclared', 'incomplete']), reads: z.array(path).max(20000), undeclaredReads: z.array(path).max(20000), externalReads: z.array(path).max(20000),
  installed: z.boolean(), unresolvedEvents: z.number().int().nonnegative(), truncated: z.boolean(),
}).strict();
export type ReadAudit = z.infer<typeof readAuditSchema>;
interface Context { base: string; scope?: 'config-directory' | 'project-root'; inputs: { path: string }[]; helperRoot: string; helpers: { path: string }[] }
const key = (value: string) => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
const inside = (root: string, value: string) => { const rel = relative(key(root), key(value)); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`); };
const portable = (value: string) => value.split(sep).join('/');

/** Compare observations with declarations; never infer or bless a dependency. */
export function classifyReadAudit(observation: unknown, context: Context): ReadAudit {
  const parsed = observationSchema.safeParse(observation);
  if (!parsed.success) return { schema: 1, coverage: 'python-open-attempts-and-modules', scope: context.scope ?? 'config-directory', status: 'incomplete', reads: [], undeclaredReads: [], externalReads: [], installed: false, unresolvedEvents: 0, truncated: false };
  const data = parsed.data;
  const declared = new Set(context.inputs.map(file => key(resolve(context.base, file.path))));
  const helpers = new Set(context.helpers.map(file => key(resolve(context.helperRoot, file.path))));
  const reads = new Set<string>(), undeclaredReads = new Set<string>(), externalReads = new Set<string>();
  for (const file of data.reads) {
    const absolute = key(file);
    // Exact declarations win, even when a project happens to sit in a runtime.
    if (!declared.has(absolute) && (helpers.has(absolute) || (!inside(context.base, absolute) && data.runtimeRoots.some(root => inside(root, absolute))))) continue;
    const name = portable(relative(context.base, resolve(file)));
    if (!inside(context.base, absolute)) { externalReads.add(name); continue; }
    reads.add(name);
    if (!declared.has(absolute)) undeclaredReads.add(name);
  }
  return {
    schema: 1, coverage: 'python-open-attempts-and-modules', scope: context.scope ?? 'config-directory', status: !data.installed || data.unresolvedEvents || data.truncated ? 'incomplete' : undeclaredReads.size ? 'undeclared' : 'clean',
    reads: [...reads].sort(), undeclaredReads: [...undeclaredReads].sort(), externalReads: [...externalReads].sort(), installed: data.installed, unresolvedEvents: data.unresolvedEvents, truncated: data.truncated,
  };
}

export type PortableReadAudit = Omit<ReadAudit, 'schema' | 'externalReads'> & {
  schema: 2;
  externalReads: { count: number; paths: 'omitted'; coverage: 'outside-enforced-scope' };
};

/** Receipt form only. Full outside paths stay in local diagnostics/cache, never blessed or hidden as empty. */
export function portableReadAudit(report: ReadAudit): PortableReadAudit {
  const { schema: _schema, externalReads, ...facts } = readAuditSchema.parse(report);
  return { schema: 2, ...facts, externalReads: { count: externalReads.length, paths: 'omitted', coverage: 'outside-enforced-scope' } };
}
