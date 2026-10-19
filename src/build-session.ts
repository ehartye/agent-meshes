export type BuildResource = 'blenderRuntime' | 'helperToolchain' | 'nativeImplementation';

/** One explicit batch, never a persistent cache. A changed resource poisons it. */
export class NativeBuildSession {
  #closed = false;
  #failed: Error | undefined;
  #entries = new Map<string, { kind: BuildResource; value: unknown; validate: () => Promise<void> }>();
  #captures: Partial<Record<BuildResource, number>> = {};
  #validations: Partial<Record<BuildResource, number>> = {};
  async get<T>(kind: BuildResource, key: string, capture: () => Promise<T>, validate: (value: T) => Promise<void>): Promise<T> {
    if (this.#closed) throw Object.assign(new Error('BUILD_SESSION_CLOSED: batch has ended'), { code: 'BUILD_SESSION_CLOSED' });
    if (this.#failed) throw this.#failed;
    const id = `${kind}:${key}`;
    const existing = this.#entries.get(id);
    if (existing) {
      try { await existing.validate(); this.#validations[kind] = (this.#validations[kind] ?? 0) + 1; }
      catch (cause) {
        this.#failed = Object.assign(new Error(`BUILD_SESSION_CHANGED: ${kind}: ${String(cause)}`, { cause }), { code: 'BUILD_SESSION_CHANGED' });
        throw this.#failed;
      }
      return existing.value as T;
    }
    const value = await capture();
    // A snapshot must still match after its complete capture, before sharing.
    await validate(value);
    this.#entries.set(id, { kind, value, validate: () => validate(value) });
    this.#captures[kind] = (this.#captures[kind] ?? 0) + 1;
    this.#validations[kind] = (this.#validations[kind] ?? 0) + 1;
    return value;
  }
  stats() { return { captures: { ...this.#captures }, validations: { ...this.#validations } }; }
  async assertUnchanged() {
    if (this.#closed) throw Object.assign(new Error('BUILD_SESSION_CLOSED: batch has ended'), { code: 'BUILD_SESSION_CLOSED' });
    if (this.#failed) throw this.#failed;
    for (const entry of this.#entries.values()) {
      try { await entry.validate(); this.#validations[entry.kind] = (this.#validations[entry.kind] ?? 0) + 1; }
      catch (cause) { this.#failed = Object.assign(new Error(`BUILD_SESSION_CHANGED: ${entry.kind}: ${String(cause)}`, { cause }), { code: 'BUILD_SESSION_CHANGED' }); throw this.#failed; }
    }
  }
  close() { this.#closed = true; this.#entries.clear(); }
}
