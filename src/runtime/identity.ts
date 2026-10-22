import type { RuntimeEnv as Env } from './environment.generated.js';
import { invariant } from '../core/errors.js';
import { id, subjectKey, timestamp } from '../core/validation.js';
import { StoredObject } from './base.js';

export function identityKey(siteId: string, kind: 'cid' | 'uid', value: string): string {
  return JSON.stringify([siteId, kind, value]);
}
/** Identity routing is separate from observation ownership: adopting a home never copies live samples. */
export class IdentityRegistry extends StoredObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS epochs (start_at INTEGER PRIMARY KEY, home TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS claims (home TEXT PRIMARY KEY, uid TEXT NOT NULL);
    `);
  }
  private browser(siteId: string, cid: string): void {
    id(siteId, 'siteId'); id(cid, 'cid');
    const identity = identityKey(siteId, 'cid', cid), prior = this.kv.get<string>('identity');
    invariant(prior === undefined || prior === identity, 'conflict', 'Browser registry identity mismatch');
    if (prior === identity) return;
    this.kv.put('identity', identity);
    this.sql.exec('INSERT OR IGNORE INTO epochs VALUES (?, ?)', 0, subjectKey(siteId, { cid }));
  }
  anonymousHome(siteId: string, cid: string, at: number): string {
    this.browser(siteId, cid); timestamp(at, 'at');
    return this.sql.exec<{ home: string }>('SELECT home FROM epochs WHERE start_at <= ? ORDER BY start_at DESC LIMIT 1', at).one().home;
  }
  takeForUid(siteId: string, cid: string, uid: string, at: number): string | null {
    id(uid, 'uid');
    return this.atomic(() => {
      const home = this.anonymousHome(siteId, cid, at);
      const transition = this.kv.get<{ uid: string | null; at: number; candidate?: string }>('transition');
      if (transition?.uid === uid && at >= transition.at) return transition.candidate ?? null;
      const claim = this.sql.exec<{ uid: string }>('SELECT uid FROM claims WHERE home = ?', home).toArray()[0];
      if (claim && claim.uid !== uid) return null;
      this.sql.exec('INSERT OR IGNORE INTO claims VALUES (?, ?)', home, uid);
      // Anonymous traffic starts a fresh epoch; authenticated traffic uses the uid's home.
      if (!transition || at >= transition.at) {
        const next = JSON.stringify([siteId, 'anonymous', cid, crypto.randomUUID()]);
        this.sql.exec('INSERT INTO epochs VALUES (?, ?) ON CONFLICT(start_at) DO UPDATE SET home = excluded.home', at, next);
        this.kv.put('transition', { uid, at, candidate: home });
      }
      return home;
    });
  }
  uidHome(siteId: string, uid: string, candidate: string | null = null): string {
    id(siteId, 'siteId'); id(uid, 'uid');
    const identity = identityKey(siteId, 'uid', uid), prior = this.kv.get<string>('identity');
    invariant(prior === undefined || prior === identity, 'conflict', 'User registry identity mismatch');
    const home = this.kv.get<string>('home');
    if (home) return home;
    const chosen = candidate ?? subjectKey(siteId, { cid: '', uid });
    this.atomic(() => { this.kv.put('identity', identity); this.kv.put('home', chosen); });
    return chosen;
  }
  logout(siteId: string, cid: string, at: number): string | null {
    return this.atomic(() => {
      const home = this.anonymousHome(siteId, cid, at);
      const transition = this.kv.get<{ uid: string | null; at: number; candidate?: string }>('transition');
      if (transition && at <= transition.at) return null;
      const next = JSON.stringify([siteId, 'anonymous', cid, crypto.randomUUID()]);
      this.sql.exec('INSERT INTO epochs VALUES (?, ?) ON CONFLICT(start_at) DO UPDATE SET home = excluded.home', at, next);
      this.kv.put('transition', { uid: null, at });
      return home;
    });
  }
}
