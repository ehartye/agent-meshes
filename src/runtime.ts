/**
 * Browser-safe entry point: author-time models become three.js scene graphs at runtime.
 *
 * A game that generates its meshes from model data (no shipped GLBs) imports from here. It
 * reaches only `three` and `zod`; it never touches the filesystem, the workspace database, the
 * CLI, the preview server or the exporter. tests/runtime-entry.test.ts fails if a Node-only
 * import ever becomes reachable from this file, so keep additions to pure geometry and model code.
 *
 * The scene graph is the one the browser viewer and the GLB exporter both build, so a part has
 * the same name, vertices and transform whichever way it reaches the screen.
 */
export { buildScene, disposeScene } from './render/scene.ts';
export { createProject, validateProject, applyOperation } from './core/model.ts';
export { geometryFor } from './geometry.ts';
export type { Operation, Part, Project } from './core/types.ts';
