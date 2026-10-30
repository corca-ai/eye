import { env, exports } from 'cloudflare:workers';
import { EyeWorker } from '../../src/runtime/service.js';
import { createExecutionContext, reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(async () => { vi.restoreAllMocks(); await reset(); });
it('shares SQL results across RPC callers and isolates filters without returning a stale range', async () => {
  const at = Date.now();
  const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ success: true,
    result: { rows: [{ bucket_start: at - 60_000, events: 91, latest_received_at: at - 1 }], metrics: { bytes_scanned: 500 } } }));
  const query = { from: at - 60_000, to: at - 1, bucketMs: 60_000 };
  const [a, b] = await Promise.all([exports.default.analyticsEventSeries(query), exports.default.analyticsEventSeries(query)]);
  expect(request).toHaveBeenCalledTimes(1);
  expect([a.meta.cacheHit, b.meta.cacheHit].sort()).toEqual([false, true]);
  expect(a.rows[0]!.events).toBe(91);
  await exports.default.analyticsEventSeries({ ...query, uid: 'other-user' });
  expect(request).toHaveBeenCalledTimes(2);
  await expect(new EyeWorker(createExecutionContext(), env).analyticsEventSeries({ ...query, to: at + 86_400_000 })).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(2);
});
