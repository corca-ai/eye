import type { EventSeriesPage } from './types.js';
import { invariant } from '../core/errors.js';

/** Owned by one installation's DO, so concurrent hosts share work. No ingestion
 * writes, storage writes or alarms. Eviction/restart simply loses this cache. */
export class EventSeriesCache {
  private readonly completed = new Map<string, EventSeriesPage>();
  private readonly pending = new Map<string, Promise<EventSeriesPage>>();
  constructor(private readonly clock: () => number = Date.now) {}
  async read(key: string, load: () => Promise<EventSeriesPage>): Promise<EventSeriesPage> {
    const cached = this.completed.get(key);
    if (cached && this.clock() < cached.meta.cacheExpiresAt) {
      this.completed.delete(key); this.completed.set(key, cached);
      return structuredClone({ ...cached, meta: { ...cached.meta, cacheHit: true } });
    }
    this.completed.delete(key);
    const pending = this.pending.get(key);
    if (pending) {
      const result = await pending;
      return structuredClone({ ...result, meta: { ...result.meta, cacheHit: true } });
    }
    invariant(this.pending.size < 16, 'unavailable', 'Too many distinct event-series queries; retry later');
    const work = Promise.resolve().then(load).then(result => {
      const page = { ...result, meta: { ...result.meta, cacheHit: false, cacheExpiresAt: this.clock() + 120_000 } };
      this.completed.set(key, structuredClone(page));
      while (this.completed.size > 64) this.completed.delete(this.completed.keys().next().value!);
      return page;
    });
    this.pending.set(key, work);
    try { return structuredClone(await work); }
    finally { this.pending.delete(key); }
  }
}
