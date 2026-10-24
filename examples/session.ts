// Optional reference for a host that ALREADY uses a Durable Object session.
// Do not add a foreground session RPC just to make decide() fast.
import { DurableObject } from 'cloudflare:workers';

interface SessionState { epoch: string; tokens: Record<string, string> }
export class EyeSession extends DurableObject {
  snapshot(): SessionState {
    const saved = this.ctx.storage.kv.get<SessionState>('eye');
    if (saved) return saved;
    const state = { epoch: crypto.randomUUID(), tokens: {} };
    this.ctx.storage.kv.put('eye', state);
    return state;
  }
  /** Captured epoch prevents a slow pre-login refresh overwriting the new session. */
  setToken(epoch: string, experimentId: string, token: string): boolean {
    const state = this.snapshot();
    if (state.epoch !== epoch) return false;
    // No await between read and write; updates for different experiments are merged.
    state.tokens = { ...state.tokens, [experimentId]: token };
    this.ctx.storage.kv.put('eye', state);
    return true;
  }
  /** Call inside the host's serialized login/logout/account-switch operation. */
  reset(): SessionState {
    const state = { epoch: crypto.randomUUID(), tokens: {} };
    this.ctx.storage.kv.put('eye', state);
    return state;
  }
}

/** Use the snapshot from the host's existing session/authentication read. */
export function eyeSessionAdapter(
  snapshot: SessionState,
  save: (epoch: string, experimentId: string, token: string) => Promise<boolean>,
) {
  return {
    decisionTokens: snapshot.tokens,
    async setDecisionToken(experimentId: string, token: string): Promise<void> {
      await save(snapshot.epoch, experimentId, token);
    },
  };
}
