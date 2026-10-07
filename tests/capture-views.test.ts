import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { captureProject } from '../src/capture.ts';
import type { Project } from '../src/core/types.ts';

const project = {
  version: 1,
  name: 'views',
  parts: [
    {
      name: 'block',
      geometry: { type: 'box', size: [1, 1, 2], segments: 12 },
      color: '#8f8f8f',
      position: [0, 0.5, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
      parent: null,
    },
  ],
  bones: [],
  clips: [],
  shells: [],
} as unknown as Project;

it('renders the requested views in order, and the default three when none are given', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'views-'));
  try {
    expect(await captureProject(project, dir, ['top', 'front'])).toEqual(['top.png', 'front.png']);
    expect(await captureProject(project, dir)).toEqual(['front.png', 'side.png', 'perspective.png']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
