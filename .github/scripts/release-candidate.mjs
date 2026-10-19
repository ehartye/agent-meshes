// Full-CI evidence for a versioned Git tree; publication does not retest a tag.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const schema = 'agent-meshes/release-candidate@1';
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const version = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value);
const positiveId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 && /^\d+$/.test(String(value));
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

function identity(root, repository) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) throw new Error('Invalid repository');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (pkg.name !== 'agent-meshes' || !version(pkg.version)) throw new Error('Invalid package version');
  const tree = git(root, 'rev-parse', 'HEAD^{tree}');
  if (!sha(tree)) throw new Error('Invalid checked Git tree');
  return { repository, tree, version: pkg.version };
}

export function verifyTag(tag, packageVersion) {
  if (!version(packageVersion) || tag !== `v${packageVersion}`) throw new Error('Release tag must match package version exactly');
}

export function recordCandidate(root, env) {
  if (env.CI_JAVASCRIPT !== 'true' || env.CI_PYTHON !== 'true' || env.CI_GEOMETRY_SWEEPS !== 'true' || env.CI_RECIPE_EXAMPLES !== 'true') throw new Error('A release receipt requires full runtime scope');
  if (git(root, 'status', '--porcelain')) throw new Error('Cannot record a dirty candidate checkout');
  if (![env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT].every(positiveId)) throw new Error('Missing GitHub run identity');
  const commit = git(root, 'rev-parse', 'HEAD');
  if (env.GITHUB_SHA !== commit) throw new Error('Checkout does not match the GitHub checked commit');
  return { schema, ...identity(root, env.GITHUB_REPOSITORY), commit, runId: Number(env.GITHUB_RUN_ID), runAttempt: Number(env.GITHUB_RUN_ATTEMPT), scope: 'full' };
}

export function verifyCandidate(receipt, expected, run) {
  if (run?.status !== 'completed' || run.conclusion !== 'success'
    || run.path !== '.github/workflows/check.yml' || run.head_repository?.full_name !== expected.repository) {
    throw new Error('Evidence must come from a successful Check run in this repository');
  }
  if (receipt?.schema !== schema || receipt.scope !== 'full' || !sha(receipt.commit)
    || !positiveId(run.id) || !positiveId(run.run_attempt)
    || receipt.runId !== run.id || receipt.runAttempt !== run.run_attempt) throw new Error('Invalid full candidate receipt/run attempt');
  for (const field of ['repository', 'tree', 'version']) {
    if (receipt[field] !== expected[field]) throw new Error(`Candidate ${field} does not match release`);
  }
  if (!sha(expected.tree) || !version(expected.version)) throw new Error('Invalid release identity');
}

export function findCandidate(expected, { api, download }) {
  const name = `validated-tree-${expected.tree}`;
  const result = api(`repos/${expected.repository}/actions/artifacts?name=${name}&per_page=100`);
  if (!Array.isArray(result.artifacts)) throw new Error('GitHub returned no artifact inventory');
  for (const artifact of result.artifacts) {
    if (artifact.name !== name || artifact.expired !== false || !positiveId(artifact.workflow_run?.id)) continue;
    const run = api(`repos/${expected.repository}/actions/runs/${artifact.workflow_run.id}`);
    if (run.status !== 'completed' || run.conclusion !== 'success') continue;
    try {
      const receipt = download(run.id, name);
      verifyCandidate(receipt, expected, run);
      return receipt;
    } catch (error) {
      console.warn(`Ignoring candidate run ${run.id}: ${error.message}`);
    }
  }
  throw new Error('No matching successful full Check receipt. Run Check for this exact candidate before retrying tag verification.');
}

function main() {
  const root = process.cwd();
  const mode = process.argv[2];
  if (mode === 'record') {
    const receipt = recordCandidate(root, process.env);
    const directory = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'meshes-candidate-'));
    const file = join(directory, 'candidate.json');
    writeFileSync(file, JSON.stringify(receipt, null, 2) + '\n');
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tree=${receipt.tree}\nreceipt=${file}\n`);
    console.log(`Validated full candidate ${receipt.version}, tree ${receipt.tree}`);
    return;
  }
  if (mode === 'verify') {
    if (process.env.GITHUB_REF_TYPE !== 'tag') throw new Error('Release verification requires a tag event');
    if (git(root, 'status', '--porcelain')) throw new Error('Cannot verify a dirty candidate checkout');
    const expected = identity(root, process.env.GITHUB_REPOSITORY);
    verifyTag(process.env.GITHUB_REF_NAME, expected.version);
    const receipt = findCandidate(expected, {
      api: path => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })),
      download: (runId, name) => {
        const directory = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'meshes-proof-'));
        execFileSync('gh', ['run', 'download', String(runId), '--repo', expected.repository, '--name', name, '--dir', directory], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
        return JSON.parse(readFileSync(join(directory, 'candidate.json'), 'utf8'));
      },
    });
    const summary = `Release ${expected.version} matches tree ${expected.tree}, full Check run https://github.com/${expected.repository}/actions/runs/${receipt.runId}. No runtime suites repeated.\n`;
    console.log(summary.trim());
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    return;
  }
  throw new Error('Usage: node .github/scripts/release-candidate.mjs record|verify');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
