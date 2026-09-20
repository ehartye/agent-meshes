import { expect, it } from 'vitest';
import { captureProject, decorateBuild, decoratorFor } from '../src/capture.ts';

it('chooses renders, renders plus preview page, or nothing from the build flags', () => {
  // `build` defaults: PNG renders and a self-contained preview.html.
  expect(decoratorFor({ preview: true, previewPage: true })).toBe(decorateBuild);
  // `--no-preview-page`: keep the PNG renders and contact sheets, skip the 1 MB preview.html.
  expect(decoratorFor({ preview: true, previewPage: false })).toBe(captureProject);
  // `--no-preview`: no browser at all, whatever the page flag says.
  expect(decoratorFor({ preview: false, previewPage: true })).toBeUndefined();
  expect(decoratorFor({ preview: false, previewPage: false })).toBeUndefined();
});
