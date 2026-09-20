import { describe, expect, it } from 'vitest';
import { Color } from 'three';
import { patternColor } from '../src/render/pattern.ts';
import type { Pattern } from '../src/core/types.ts';

const base = new Color('#ff0000'), ink = new Color('#0000ff');
const hex = (c: Color) => `#${c.getHexString()}`;

describe('patternColor', () => {
  it('paints dots within 0.3 of a lattice point spaced by size', () => {
    const dots: Pattern = { type: 'dots', color: '#0000ff', size: 1 };
    expect(hex(patternColor(dots, base, [0, 0, 0]))).toBe(hex(ink));
    expect(hex(patternColor(dots, base, [2.2, -3.1, 4.05]))).toBe(hex(ink));
    expect(hex(patternColor(dots, base, [0.5, 0, 0]))).toBe(hex(base));
    expect(hex(patternColor(dots, base, [0.25, 0.25, 0]))).toBe(hex(base));
    expect(hex(patternColor({ ...dots, offset: [0.5, 0, 0] }, base, [0.5, 0, 0]))).toBe(hex(ink));
  });

  it('alternates stripe bands of width size/2 along the axis, y by default', () => {
    const stripes: Pattern = { type: 'stripes', color: '#0000ff', size: 0.4 };
    expect(hex(patternColor(stripes, base, [7, 0.1, 9]))).toBe(hex(ink));
    expect(hex(patternColor(stripes, base, [7, 0.3, 9]))).toBe(hex(base));
    expect(hex(patternColor(stripes, base, [7, 0.5, 9]))).toBe(hex(ink));
    expect(hex(patternColor(stripes, base, [7, -0.1, 9]))).toBe(hex(base));
    expect(hex(patternColor({ ...stripes, axis: 'x' }, base, [0.3, 0.1, 9]))).toBe(hex(base));
    expect(hex(patternColor({ ...stripes, axis: 'x' }, base, [0.1, 0.3, 9]))).toBe(hex(ink));
  });

  it('checks the two axes perpendicular to the axis by cell parity', () => {
    const checks: Pattern = { type: 'checks', color: '#0000ff', size: 1 };
    expect(hex(patternColor(checks, base, [0.5, 3.3, 0.5]))).toBe(hex(ink));
    expect(hex(patternColor(checks, base, [1.5, 3.3, 0.5]))).toBe(hex(base));
    expect(hex(patternColor(checks, base, [1.5, 3.3, 1.5]))).toBe(hex(ink));
    expect(hex(patternColor(checks, base, [-0.5, 3.3, 0.5]))).toBe(hex(base));
    expect(hex(patternColor({ ...checks, axis: 'z' }, base, [0.5, 1.5, 3.3]))).toBe(hex(base));
  });

  it('is deterministic and leaves its inputs alone', () => {
    const dots: Pattern = { type: 'dots', color: '#00ff00', size: 0.2 };
    const a = patternColor(dots, base, [0.41, 0.2, 0.19]).clone();
    expect(patternColor(dots, base, [0.41, 0.2, 0.19]).equals(a)).toBe(true);
    expect(hex(base)).toBe('#ff0000');
  });
});
