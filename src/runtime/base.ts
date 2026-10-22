import type { RuntimeEnv as Env } from './environment.generated.js';
import { DurableObject } from 'cloudflare:workers';

/** Alarm metadata uses the same SQLite transaction boundary as local state. */
export abstract class StoredObject extends DurableObject<Env> {
  protected get kv(): SyncKvStorage { return this.ctx.storage.kv; }
  protected get sql(): SqlStorage { return this.ctx.storage.sql; }

  protected async wakeAt(at: number): Promise<void> {
    const scheduled = this.kv.get<number>('alarmAt');
    if (scheduled !== undefined && scheduled <= at) return;
    const pending = this.ctx.storage.setAlarm(at);
    this.kv.put('alarmAt', at);
    await pending;
  }
  protected alarmStarted(): void { this.kv.delete('alarmAt'); }
  protected atomic<T>(fn: () => T): T { return this.ctx.storage.transactionSync(fn); }
}

/** Only for trusted, versioned records written by this package, never request input. */
export function storedJson<T>(text: string): T { return JSON.parse(text) as T; }
