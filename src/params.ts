/**
 * Parametric templates: one Project-shaped JSON, many ships.
 *
 * A template is a Project (version, name, parts, bones, ...) plus a `params` table. Anywhere a
 * number or colour is allowed, it may instead be one of these objects:
 *
 *   {"$param": "width"}                  the value of parameter `width`
 *   {"$expr": "width * 0.5 + 0.2"}       a number computed from parameters
 *   {"$hsl": [h, s, l]}                  a colour; h in degrees, s and l in 0..1; each entry a number or an
 *                                        {"$param"}/{"$expr"} object. Colour is the only string-valued form.
 *
 * Expression grammar (no eval, no Function; a hand-written tokenizer and recursive-descent parser):
 *   numbers (1, .5, 2.5e-1), parameter names, pi, + - * / % ^ (power, right-associative), unary - and +,
 *   parentheses, and the functions min max abs sqrt floor ceil round sin cos clamp(x,lo,hi) mix(a,b,t).
 * Parts may omit position, rotation, scale, colour, parent, size and segments; instantiate fills the `add` defaults.
 * Anything else (member access, strings, assignment, unknown names or functions) is a ModelError.
 *
 * seedParams algorithm: for each parameter, h = FNV-1a 32-bit over (seed as 4 little-endian bytes, then the
 * UTF-8 bytes of the name); u = first output of mulberry32(h) in [0,1); value = min + u*(max-min), rounded to
 * the nearest integer in range when `integer` is set. Seeding per name (not per position) means adding or
 * reordering parameters never changes the others. Only integer ops (Math.imul, shifts) and IEEE-754 double
 * multiply/add are used, so the output is identical across runs and platforms.
 */
import { ModelError } from './errors.ts';
import { validateProject } from './core/model.ts';
import type { Project } from './core/types.ts';

export interface ParamSpec { default: number; min: number; max: number; integer?: boolean }
export interface Template { version: 1; name: string; params: Record<string, ParamSpec>; [key: string]: unknown }
export type ParamValues = Record<string, number>;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONSTANTS: Record<string, number> = { pi: Math.PI };

function checkParams(template: Template): void {
  if (!template || typeof template !== 'object' || typeof template.params !== 'object' || !template.params) {
    throw new ModelError('A template needs a "params" table.', { path: 'params', hint: 'Use {"params":{"width":{"default":1,"min":0.5,"max":2}}}; an empty table is allowed.' });
  }
  for (const [name, spec] of Object.entries(template.params)) {
    const path = `params.${name}`;
    if (!NAME.test(name)) throw new ModelError(`Parameter name "${name}" is not an identifier.`, { path, hint: 'Use letters, digits and underscores, not starting with a digit.' });
    if (Object.hasOwn(CONSTANTS, name)) throw new ModelError(`Parameter name "${name}" is reserved.`, { path });
    for (const key of ['default', 'min', 'max'] as const) {
      if (typeof spec?.[key] !== 'number' || !Number.isFinite(spec[key])) throw new ModelError(`Parameter "${name}" needs a finite numeric ${key}.`, { path: `${path}.${key}`, value: spec?.[key] });
    }
    if (spec.min > spec.max) throw new ModelError(`Parameter "${name}" has min ${spec.min} above max ${spec.max}.`, { path });
    if (spec.default < spec.min || spec.default > spec.max) throw new ModelError(`Parameter "${name}" default ${spec.default} is outside ${spec.min}..${spec.max}.`, { path: `${path}.default`, value: spec.default });
  }
}

/** Defaults overlaid with `values`; every value is range-checked. Unknown names and non-finite numbers are errors. */
export function resolveParams(template: Template, values: ParamValues = {}): ParamValues {
  checkParams(template);
  const out: ParamValues = {};
  for (const [name, spec] of Object.entries(template.params)) out[name] = spec.default;
  for (const [name, value] of Object.entries(values)) {
    const spec = Object.hasOwn(template.params, name) ? template.params[name] : undefined;
    if (!spec) throw new ModelError(`Unknown parameter "${name}".`, { path: `values.${name}`, hint: `Declared parameters: ${Object.keys(template.params).join(', ') || '(none)'}.` });
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new ModelError(`Parameter "${name}" must be a finite number.`, { path: `values.${name}`, value });
    if (value < spec.min || value > spec.max) throw new ModelError(`Parameter "${name}" is ${value}, outside its range ${spec.min}..${spec.max}.`, { path: `values.${name}`, value, hint: `Choose a value from ${spec.min} to ${spec.max}, or use seedParams to stay in range.` });
    if (spec.integer && !Number.isInteger(value)) throw new ModelError(`Parameter "${name}" must be an integer.`, { path: `values.${name}`, value });
    out[name] = value;
  }
  return out;
}

// ---- expression evaluator ----

type Token = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  const re = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|([-+*/%^(),]))/y;
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) throw new ModelError(`Unexpected character "${src.slice(pos).trimStart()[0]}" in expression "${src}".`, { value: src, hint: 'Expressions allow numbers, parameter names, + - * / % ^, parentheses and functions min max abs sqrt floor ceil round sin cos clamp mix.' });
    if (m[1] !== undefined) tokens.push({ t: 'num', v: Number(m[1]) });
    else if (m[2] !== undefined) tokens.push({ t: 'id', v: m[2] });
    else tokens.push({ t: 'op', v: m[3] });
    pos = re.lastIndex;
  }
  return tokens;
}

const FUNCTIONS: Record<string, { arity: number | 'any'; fn: (...a: number[]) => number }> = {
  min: { arity: 'any', fn: Math.min }, max: { arity: 'any', fn: Math.max },
  abs: { arity: 1, fn: Math.abs }, sqrt: { arity: 1, fn: Math.sqrt }, floor: { arity: 1, fn: Math.floor }, ceil: { arity: 1, fn: Math.ceil },
  round: { arity: 1, fn: Math.round }, sin: { arity: 1, fn: Math.sin }, cos: { arity: 1, fn: Math.cos },
  clamp: { arity: 3, fn: (x, lo, hi) => Math.min(hi, Math.max(lo, x)) },
  mix: { arity: 3, fn: (a, b, t) => a + (b - a) * t },
};

function evaluate(src: string, vars: ParamValues): number {
  const tokens = tokenize(src);
  let i = 0;
  const fail = (msg: string): never => { throw new ModelError(`${msg} in expression "${src}".`, { value: src }); };
  const isOp = (v: string) => tokens[i]?.t === 'op' && tokens[i].v === v;
  function expr(): number {
    let left = term();
    while (isOp('+') || isOp('-')) { const op = tokens[i++].v; const right = term(); left = op === '+' ? left + right : left - right; }
    return left;
  }
  function term(): number {
    let left = unary();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = tokens[i++].v; const right = unary();
      if ((op === '/' || op === '%') && right === 0) fail('Division by zero');
      left = op === '*' ? left * right : op === '/' ? left / right : left % right;
    }
    return left;
  }
  function unary(): number {
    if (isOp('-')) { i++; return -unary(); }
    if (isOp('+')) { i++; return unary(); }
    return power();
  }
  function power(): number {
    const base = primary();
    if (isOp('^')) { i++; return Math.pow(base, unary()); }
    return base;
  }
  function primary(): number {
    const tok = tokens[i++];
    if (!tok) return fail('Unexpected end');
    if (tok.t === 'num') return tok.v;
    if (tok.t === 'op') {
      if (tok.v === '(') { const v = expr(); if (!isOp(')')) fail('Missing ")"'); i++; return v; }
      return fail(`Unexpected "${tok.v}"`);
    }
    if (isOp('(')) {
      const spec = Object.hasOwn(FUNCTIONS, tok.v) ? FUNCTIONS[tok.v] : undefined;
      if (!spec) return fail(`Unknown function "${tok.v}"`);
      i++;
      const args: number[] = [];
      if (!isOp(')')) { args.push(expr()); while (isOp(',')) { i++; args.push(expr()); } }
      if (!isOp(')')) fail('Missing ")"');
      i++;
      if (spec.arity === 'any' ? args.length < 1 : args.length !== spec.arity) fail(`Function "${tok.v}" takes ${spec.arity === 'any' ? 'at least 1 argument' : `${spec.arity} argument${spec.arity === 1 ? '' : 's'}`}, got ${args.length}`);
      return spec.fn(...args);
    }
    if (Object.hasOwn(vars, tok.v)) return vars[tok.v];
    if (Object.hasOwn(CONSTANTS, tok.v)) return CONSTANTS[tok.v];
    return fail(`Unknown parameter "${tok.v}" (declared: ${Object.keys(vars).join(', ') || 'none'})`);
  }
  const value = expr();
  if (i < tokens.length) fail(`Unexpected "${tokens[i].v}"`);
  if (!Number.isFinite(value)) fail('Result is not a finite number');
  return value;
}

// ---- substitution ----

const hex2 = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 255).toString(16).padStart(2, '0');
function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360 / 360;
  const a = Math.min(1, Math.max(0, s)) * Math.min(l, 1 - l);
  const f = (n: number) => { const k = (n + hue * 12) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return `#${hex2(f(0))}${hex2(f(8))}${hex2(f(4))}`;
}

function substitute(node: unknown, vars: ParamValues, path: string): unknown {
  if (Array.isArray(node)) return node.map((item, index) => substitute(item, vars, `${path}[${index}]`));
  if (!node || typeof node !== 'object') return node;
  const obj = node as Record<string, unknown>;
  const keys = Object.keys(obj);
  const directive = keys.find(key => key.startsWith('$'));
  if (!directive) return Object.fromEntries(keys.map(key => [key, substitute(obj[key], vars, path ? `${path}.${key}` : key)]));
  try {
    if (keys.length !== 1) throw new ModelError(`A "${directive}" object must have no other keys.`);
    const arg = obj[directive];
    if (directive === '$param') {
      if (typeof arg !== 'string' || !Object.hasOwn(vars, arg)) throw new ModelError(`Unknown parameter "${String(arg)}".`, { value: arg, hint: `Declared parameters: ${Object.keys(vars).join(', ') || '(none)'}.` });
      return vars[arg];
    }
    if (directive === '$expr') {
      if (typeof arg !== 'string') throw new ModelError('"$expr" takes a string.', { value: arg });
      return evaluate(arg, vars);
    }
    if (directive === '$hsl') {
      if (!Array.isArray(arg) || arg.length !== 3) throw new ModelError('"$hsl" takes [hue, saturation, lightness].', { value: arg });
      const [h, s, l] = arg.map(entry => {
        const v = typeof entry === 'number' ? entry : substitute(entry, vars, path);
        if (typeof v !== 'number') throw new ModelError('"$hsl" entries must be numbers or numeric expressions.', { value: entry });
        return v;
      });
      return hslToHex(h, s, l);
    }
    throw new ModelError(`Unknown directive "${directive}".`, { hint: 'Use $param, $expr or $hsl.' });
  } catch (error) {
    if (error instanceof ModelError) throw new ModelError(error.summary, { path, value: error.value, hint: error.hint });
    throw error;
  }
}

/** Substitute parameter values into the template and return a validated Project. Values default to each parameter's default. */
export function instantiate(template: Template, values: ParamValues = {}): Project {
  const vars = resolveParams(template, values);
  const { params: _params, ...rest } = template;
  const project = substitute(rest, vars, '') as { parts?: Record<string, unknown>[] };
  // Like the `add` operation, a template part may omit transform, colour, parent, size and segments.
  if (Array.isArray(project.parts)) {
    project.parts = project.parts.map(part => ({ color: '#64b9c4', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], parent: null, ...part, geometry: { size: [1, 1, 1], segments: 12, ...(part.geometry as object) } }));
  }
  return validateProject(project);
}

function fnv1a(seed: number, name: string): number {
  let h = 0x811c9dc5;
  const mix = (byte: number) => { h ^= byte; h = Math.imul(h, 0x01000193); };
  for (let shift = 0; shift < 32; shift += 8) mix((seed >>> shift) & 0xff);
  for (const byte of new TextEncoder().encode(name)) mix(byte);
  return h >>> 0;
}
function mulberry32(a: number): number {
  a = (a + 0x6d2b79f5) >>> 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Deterministic parameter values for an integer seed, always inside each declared range. See the file header for the algorithm. */
export function seedParams(template: Template, seed: number): ParamValues {
  if (!Number.isInteger(seed)) throw new ModelError(`Seed must be an integer, got ${seed}.`, { path: 'seed', value: seed });
  checkParams(template);
  const out: ParamValues = {};
  for (const [name, spec] of Object.entries(template.params)) {
    const u = mulberry32(fnv1a(seed | 0, name));
    let v = spec.min + u * (spec.max - spec.min);
    if (spec.integer) v = Math.min(Math.floor(spec.max), Math.max(Math.ceil(spec.min), Math.round(v)));
    out[name] = Math.min(spec.max, Math.max(spec.min, v));
  }
  return out;
}
