import type { Part, Project, Vec2 } from './core/types.ts';

/**
 * Authoring warnings: things that pass validation but almost certainly render wrong. They never block an operation;
 * `batch --dry-run`, `batch`, `op` and `inspect` report them under `warnings`.
 */
export interface ProjectWarning { code: 'LATHE_PROFILE_INWARD'; part: string; message: string; hint: string }

export type LatheWinding = 'outward' | 'inward' | 'flat';

/**
 * Which way a lathe profile's faces point. A lathe's faces are on the right of the direction of travel in the
 * [radius, height] plane, so a profile that runs counter-clockwise (bottom to top along the outside, or for a hollow
 * piece down the inside and back up the outside) faces away from the material and a clockwise one faces into it. The
 * profile is closed back to its first point (along the axis when both ends sit on it) to measure that. A profile with
 * no area (a single wall) is judged by its direction alone: rising faces outward, falling faces the axis.
 */
export function latheWinding(profile: readonly Vec2[]): LatheWinding {
  let twiceArea = 0, rMax = 0, hMin = Infinity, hMax = -Infinity;
  profile.forEach(([r, h], i) => {
    const [r1, h1] = profile[(i + 1) % profile.length];
    twiceArea += r * h1 - r1 * h;
    rMax = Math.max(rMax, r); hMin = Math.min(hMin, h); hMax = Math.max(hMax, h);
  });
  const extent = Math.max(rMax, hMax - hMin);
  if (Math.abs(twiceArea) > 1e-9 * extent * extent) return twiceArea > 0 ? 'outward' : 'inward';
  const rise = profile[profile.length - 1][1] - profile[0][1];
  return Math.abs(rise) <= 1e-12 * Math.max(extent, 1) ? 'flat' : rise > 0 ? 'outward' : 'inward';
}

const reversedCorners = (part: Part) => {
  const corners = part.geometry.corners, n = part.geometry.profile?.length ?? 0;
  return corners?.length ? ` and corners ${JSON.stringify(corners.map(i => n - 1 - i).sort((a, b) => a - b))}` : '';
};

/** Every warning for a project, in part order. Shell members and cutters are skipped: a shell rebuilds them as a smooth field, so winding does not matter there. */
export function lintProject(project: Project): ProjectWarning[] {
  const inShell = new Set((project.shells ?? []).flatMap(shell => [...shell.parts, ...(shell.cut ?? [])]));
  const warnings: ProjectWarning[] = [];
  for (const part of project.parts) {
    if (part.geometry.type !== 'lathe' || !part.geometry.profile || inShell.has(part.name)) continue;
    if (latheWinding(part.geometry.profile) !== 'inward') continue;
    warnings.push({
      code: 'LATHE_PROFILE_INWARD', part: part.name,
      message: `Part "${part.name}": the lathe profile runs clockwise in [radius, height] (top to bottom along the outside), so its faces point inward and it renders inside out (dark, or only the back-face outline shows).`,
      hint: `Reverse the profile array${reversedCorners(part)}. Profiles run bottom to top along the outside; a hollow piece (a bell, a cup) runs down the inner wall and back up the outer wall.`,
    });
  }
  return warnings;
}
