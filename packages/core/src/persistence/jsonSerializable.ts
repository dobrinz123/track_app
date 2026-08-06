// Runtime guard enforcing that a value is plain-JSON-serializable before it is
// persisted through a Promise-based repository call. Unlike JSON.stringify
// (which silently drops undefined values/functions and turns array holes into
// null), this walks the value and throws a descriptive Error the first time it
// finds something that would be silently corrupted by a JSON round-trip.
export function assertJsonSerializable(value: unknown, path = '$', seen: WeakSet<object> = new WeakSet()): void {
  if (value === null) return;

  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return;

  if (t === 'undefined') {
    throw new Error(`Value at ${path} is undefined; not JSON-serializable.`);
  }
  if (t === 'function') {
    throw new Error(`Value at ${path} is a function; not JSON-serializable.`);
  }
  if (t === 'symbol' || t === 'bigint') {
    throw new Error(`Value at ${path} is a ${t}; not JSON-serializable.`);
  }
  if (t !== 'object') {
    throw new Error(`Value at ${path} has unsupported type "${t}"; not JSON-serializable.`);
  }

  const obj = value as object;
  if (seen.has(obj)) {
    throw new Error(`Value at ${path} contains a circular reference; not JSON-serializable.`);
  }
  seen.add(obj);

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i += 1) {
      // Bracket access on a sparse-array hole yields `undefined`, which the
      // recursive call below rejects -- this is how array holes get caught.
      assertJsonSerializable((obj as unknown[])[i], `${path}[${i}]`, seen);
    }
    return;
  }

  for (const key of Object.keys(obj)) {
    assertJsonSerializable((obj as Record<string, unknown>)[key], `${path}.${key}`, seen);
  }
}
