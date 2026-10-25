import { expect, it } from 'vitest';
import { DictionaryCache, sendExportBatches } from '../../src/analytics/export.js';
import { analyticsRecord, type AnalyticsRecord } from '../../src/analytics/records.js';

const record = (siteId = 's', at = 0, attributes = { key: 'v' }) => analyticsRecord({ siteId, subjectKey: 'u' }, 'events', 'e', 1, at, at, {}, {}, attributes);
it('only suppresses acknowledged daily dictionary identities, preserving raw attributes', async () => {
  const cache = new DictionaryCache(2), sent: AnalyticsRecord[] = [];
  const send = async (batch: AnalyticsRecord[]) => { sent.push(...batch); };
  await sendExportBatches([{ record: record() }], send, cache);
  await sendExportBatches([{ record: record() }], send, cache);
  expect(sent.filter(r => r.table_name === 'events')).toHaveLength(2);
  expect(sent.filter(r => r.table_name === 'attribute_keys')).toHaveLength(1);
  expect(JSON.parse(sent[0]!.attributes_json)).toEqual({ key: 'v' });
  await sendExportBatches([{ record: record('other') }], send, cache);
  await sendExportBatches([{ record: record('s', 86_400_000) }], send, cache);
  await sendExportBatches([{ record: record() }], send, cache); // Oldest identity was evicted.
  expect(sent.filter(r => r.table_name === 'attribute_keys')).toHaveLength(4);
});
it('retries failed dictionary sends and permits independent concurrent misses', async () => {
  const cache = new DictionaryCache(), rows = [{ record: record() }];
  await expect(sendExportBatches(rows, async () => { throw Error('offline'); }, cache)).rejects.toThrow('offline');
  let resolve!: () => void;
  const wait = new Promise<void>(done => { resolve = done; });
  const chunks: AnalyticsRecord[][] = [];
  const first = sendExportBatches(rows, async batch => { chunks.push(batch); await wait; }, cache);
  await sendExportBatches(rows, async batch => { chunks.push(batch); }, cache);
  resolve(); await first;
  expect(chunks.every(chunk => chunk.some(r => r.table_name === 'attribute_keys'))).toBe(true);
  const later: AnalyticsRecord[] = [];
  await sendExportBatches(rows, async batch => { later.push(...batch); }, cache);
  expect(later.some(r => r.table_name === 'attribute_keys')).toBe(false);
});
it('keeps source and scalar types distinct even for the same site, day and key', async () => {
  const cache = new DictionaryCache(), sent: AnalyticsRecord[] = [];
  const events = [
    record(),
    analyticsRecord({ siteId: 's', subjectKey: 'u' }, 'events', 'n', 1, 0, 0, {}, {}, { key: 1 }),
    analyticsRecord({ siteId: 's', subjectKey: 'u' }, 'events', 'null', 1, 0, 0, {}, {}, { key: null }),
    analyticsRecord({ siteId: 's', subjectKey: 'u' }, 'observations', 'sample', 2, 0, 0, {}, {}, { key: 'v' }),
  ];
  for (const row of events) await sendExportBatches([{ record: row }], async batch => { sent.push(...batch); }, cache);
  expect(sent.filter(r => r.table_name === 'attribute_keys').map(r => JSON.parse(r.payload_json))).toEqual([
    { key: 'key', type: 'string', source: 'event' }, { key: 'key', type: 'number', source: 'event' },
    { key: 'key', type: 'null', source: 'event' }, { key: 'key', type: 'string', source: 'user' },
  ]);
});
