import type { RuntimeEnv as Env } from './environment.generated.js';
import { DurableObject } from 'cloudflare:workers';

/** Alarm metadata uses the same SQLite transaction boundary as local state. */
export abstract class StoredObject extends DurableObject<Env> {
  protected get kv(): SyncKvStorage { return this.ctx.storage.kv; }
  protected get sql(): SqlStorage { return this.ctx.storage.sql; }

  protected async wakeAt(at: number): Promise<void> {
    const retryAt = this.kv.get<number>('alarmRetryAt') ?? 0;
    at = Math.max(at, retryAt);
    const scheduled = this.kv.get<number>('alarmAt');
    if (scheduled !== undefined && scheduled >= retryAt && scheduled <= at) return;
    const pending = this.ctx.storage.setAlarm(at);
    this.kv.put('alarmAt', at);
    await pending;
  }
  /** Keep downstream outages from turning every new event into an immediate retry. */
  protected async retryAlarm(work: () => Promise<void>): Promise<void> {
    this.alarmStarted();
    const retryAt = this.kv.get<number>('alarmRetryAt');
    if (retryAt !== undefined && retryAt > Date.now()) { await this.wakeAt(retryAt); return; }
    // Persist a fallback before external I/O. Native alarm retries are finite;
    // an object reset must not strand a durable outbox indefinitely.
    await this.wakeAt(Date.now() + 60_000);
    try {
      await work();
      if (this.kv.get('alarmFailures') !== undefined) this.kv.delete('alarmFailures');
      if (this.kv.get('alarmRetryAt') !== undefined) this.kv.delete('alarmRetryAt');
    } catch (error) {
      const failures = (this.kv.get<number>('alarmFailures') ?? 0) + 1;
      const jitter = (Number.parseInt(this.ctx.id.toString().slice(-4), 16) % 1000) / 4000;
      const delay = Math.min(300_000, Math.ceil(2000 * 2 ** Math.min(failures - 1, 8) * (1 + jitter)));
      const at = Date.now() + delay;
      this.kv.put('alarmFailures', failures);
      this.kv.put('alarmRetryAt', at);
      await this.wakeAt(at);
      console.warn(JSON.stringify({ component: 'eye', operation: 'alarm_retry', failures, retryAt: at,
        code: typeof error === 'object' && error !== null && 'code' in error ? error.code : 'unavailable',
        overloaded: typeof error === 'object' && error !== null && 'overloaded' in error && error.overloaded === true }));
    }
  }
  protected alarmStarted(): void { this.kv.delete('alarmAt'); }
  protected atomic<T>(fn: () => T): T { return this.ctx.storage.transactionSync(fn); }
}

/** Only for trusted, versioned records written by this package, never request input. */
export function storedJson<T>(text: string): T { return JSON.parse(text) as T; }
