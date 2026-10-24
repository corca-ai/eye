import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { literal } from '../../dist/analytics/sql.js';
const directory = dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(await readFile(join(directory, '.state/resources.json')));
if (!state.roll300?.pipeline) throw new Error('Run roll-provision.mjs first');
const original = JSON.parse(await readFile(join(directory, '.state/cohort-fixture.json')));
const path = join(directory, '.state/roll-fixture.json');
let fixture;
try { fixture = JSON.parse(await readFile(path)); }
catch (error) { if (error.code !== 'ENOENT') throw error; fixture = { siteId: `roll-${crypto.randomUUID()}`, rounds: [] }; }
if (process.argv.includes('--seed')) {
  const { url } = JSON.parse(await readFile(join(directory, '.state/deployment.json')));
  const { TEST_TOKEN } = JSON.parse(await readFile(join(directory, '.state/site-secrets.json')));
  for (let round = 0; round < 6; round++) {
    if (fixture.rounds[round]?.completedAt) continue;
    const startedAt = fixture.rounds[round]?.startedAt ?? Date.now();
    fixture.rounds[round] = { startedAt };
    await writeFile(path, JSON.stringify(fixture), { mode: 0o600 });
    const events = original.events.filter(e => e.kind !== 'track').map(e => {
      const event = structuredClone(e), prefix = `r${round}:`;
      event.eventId = prefix + event.eventId; event.subject.cid = prefix + event.subject.cid;
      if (event.subject.uid !== undefined) event.subject.uid = prefix + event.subject.uid;
      if (event.assignment) event.assignment.assignmentId = prefix + event.assignment.assignmentId;
      if (event.sample) event.sample.sampleId = prefix + event.sample.sampleId;
      event.attributes = { ...event.attributes, rollRound: round };
      return event;
    });
    for (let i = 0; i < events.length; i += 100) {
      const response = await fetch(`${url}/benchmark/seed`, { method: 'POST', headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(events.slice(i, i + 100).map(event => ({ siteId: fixture.siteId, receivedAt: Date.now(), event }))), signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`Seed HTTP ${response.status}; retry uses stable IDs`);
    }
    fixture.rounds[round].completedAt = Date.now(); fixture.rounds[round].events = events.length;
    await writeFile(path, JSON.stringify(fixture), { mode: 0o600 });
    console.log(JSON.stringify({ round, ...fixture.rounds[round] }));
    if (round < 5) await new Promise(resolve => setTimeout(resolve, Math.max(0, startedAt + 60000 - Date.now())));
  }
} else {
  const results = {};
  for (const namespace of ['eye', 'eye_roll300']) {
    const query = `SELECT json_get_int(attributes_json,'rollRound') AS round,
json_get_str(payload_json,'kind') AS kind, arm_id, CASE WHEN uid IS NULL THEN 'cid' ELSE 'uid' END AS identity,
COUNT(DISTINCT record_id) AS events FROM ${namespace}.events WHERE site_id=${literal(fixture.siteId)}
GROUP BY json_get_int(attributes_json,'rollRound'),json_get_str(payload_json,'kind'),arm_id,CASE WHEN uid IS NULL THEN 'cid' ELSE 'uid' END
ORDER BY round,kind,arm_id,identity LIMIT 1000`;
    const response = await fetch(`https://api.sql.cloudflarestorage.com/api/v1/accounts/${state.account}/basin-sql/query/${state.prefix}-data`, {
      method: 'POST', headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ warehouse: `${state.account}_${state.prefix}-data`, query }), signal: AbortSignal.timeout(60000) });
    const body = await response.json(); if (!response.ok) throw new Error(JSON.stringify(body.errors));
    results[namespace] = { ...body.result, observedAt: Date.now() };
  }
  const perRound = original.events.filter(event => event.kind !== 'track').length;
  const expected = 6 * perRound;
  const seeded = fixture.rounds.length === 6 && fixture.rounds.every(round => Number.isFinite(round.completedAt) && round.events === perRound);
  const everyRound = Object.values(results).every(result => Array.from({ length: 6 }, (_, i) => i).every(round =>
    result.rows.filter(row => row.round === round).reduce((n, row) => n + row.events, 0) === perRound));
  const counts = Object.fromEntries(Object.entries(results).map(([key, value]) => [key, value.rows.reduce((n, row) => n + row.events, 0)]));
  const tuples = rows => rows.map(({ round, kind, arm_id, identity, events }) => [round, kind, arm_id, identity, events]);
  const matching = JSON.stringify(tuples(results.eye.rows)) === JSON.stringify(tuples(results.eye_roll300.rows));
  const summary = { expected, counts, matching, complete: seeded && everyRound && counts.eye === expected && counts.eye_roll300 === expected && matching };
  await writeFile(join(directory, `results/roll-${Date.now()}.json`), JSON.stringify({ fixture, summary, results }, null, 2));
  console.log(JSON.stringify(summary));
  if (!summary.complete) process.exitCode = 1;
}
