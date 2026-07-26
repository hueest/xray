// Test-only helpers shared by the suites that drive Vite plugin hooks
// directly. Not a build entry; nothing in dist imports this.

export function assertCallable<T extends (...args: any[]) => unknown>(
  value: unknown,
  _shape?: T,
): asserts value is T {
  if (typeof value !== 'function') throw new TypeError('expected callable hook')
}

/** Unwrap a Vite hook (bare function or `{ handler }` object) into its callable. */
export function callable<T extends (...args: any[]) => unknown>(hook: unknown, _shape?: T): T {
  const value = typeof hook === 'object' && hook !== null && 'handler' in hook ? hook.handler : hook
  assertCallable(value, _shape)
  return value
}
