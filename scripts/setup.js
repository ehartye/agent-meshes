#!/usr/bin/env node
// Install or check the managed agent-meshes runtime outside the plugin cache. Usage: node scripts/setup.js [--check] [--json]
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blenderInstallHint, findBlenderDetailsFrom, inspectInstallation, installRuntime } from './managed-runtime.js';

const source = join(dirname(fileURLToPath(import.meta.url)), '..');
try {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--check', '--json'].includes(arg))) throw new Error('Usage: node scripts/setup.js [--check] [--json]');
  if (!args.includes('--check')) installRuntime(source);
  const report = inspectInstallation(source);
  report.node = process.versions.node;
  // refine.ts needs only Node built-ins, so the plugin source can answer before the runtime is installed.
  const blender = findBlenderDetailsFrom(report.dependencies ? report.runtimeRoot : source);
  report.blender = blender?.command ?? null;
  report.blenderSource = blender?.source ?? null;
  report.blenderVersion = blender?.version ?? null;
  report.blenderRequired = '5.2 LTS';
  report.blenderSupported = blender?.supported ?? null;
  if (!blender) report.blenderHint = blenderInstallHint();
  // Only Blender 5.2 LTS is supported. A check that finds any other Blender (or one whose version cannot be read) fails.
  const blenderRejected = blender && !blender.supported;
  if (blenderRejected) report.blenderError = blender.message;
  // `--check` exits 1 whenever ok is false, including the expected "not installed yet" first run.
  const steps = [];
  if (!report.ok) steps.push('Not ready: run `node scripts/setup.js` without --check (exit 1 from --check on a first run means "not yet installed", not a fault).');
  if (blenderRejected && args.includes('--check')) { report.ok = false; steps.push(blender.message); }
  if (steps.length) report.nextStep = steps.join(' ');
  console.log(JSON.stringify(report, null, args.includes('--json') ? undefined : 2));
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  if (process.argv.includes('--json')) console.log(JSON.stringify({ ok: false, errors: [error.message] }));
  process.exitCode = 1;
}
