/** Deterministic event-time ordering. Equal timestamps are ordered by stable event ID. */
export function compareEvents(a: { occurredAt: number; eventId: string }, b: { occurredAt: number; eventId: string }): number {
  return a.occurredAt - b.occurredAt || compareIdentifiers(a.eventId, b.eventId);
}

/** SQLite BINARY compares UTF-8 bytes, whose order agrees with Unicode scalar values,
 * not JavaScript's UTF-16 code units for supplementary characters. */
export function compareIdentifiers(a: string, b: string): number {
  if (a === b) return 0;
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i)!, y = b.codePointAt(j)!;
    if (x !== y) return x < y ? -1 : 1;
    i += x > 0xffff ? 2 : 1; j += y > 0xffff ? 2 : 1;
  }
  return i < a.length ? 1 : -1;
}
