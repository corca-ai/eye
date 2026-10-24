import { compareEvents } from './attribution.js';
import { invariant } from './errors.js';
import type { IdentityEvent, Subject } from './types.js';

type Position = { readonly occurredAt: number; readonly eventId: string };
type SubjectEvent = Position & { readonly subject: Subject };
type Segment = {
  readonly start: Position | null;
  readonly uid: string | undefined;
  /** Only an anonymous segment immediately preceding a login may be claimed. */
  claim?: { readonly uid: string; readonly at: Position };
};

/** Bounded, site-scoped raw-history index for a single reduction job. No persisted
 * subject state or transitive cid/uid union. Supply deduplicated identify/logout
 * events from the same frozen input as the exposures and goals.
 */
export class IdentityHistory {
  private readonly browsers = new Map<string, Segment[]>();

  constructor(events: readonly IdentityEvent[]) {
    // Sorting a copy preserves the caller's immutable raw snapshot.
    for (const event of [...events].sort(compareEvents)) {
      const cid = event.subject.cid;
      const segments = this.browsers.get(cid) ?? [{ start: null, uid: undefined }];
      const previous = segments.at(-1)!;
      if (event.kind === 'identify') {
        const uid = event.subject.uid;
        invariant(uid !== undefined, 'invalid_input', 'identify requires uid');
        // Repeated login metadata must not split an authenticated session.
        if (previous.uid === uid) continue;
        if (previous.uid === undefined) previous.claim = { uid, at: event };
        segments.push({ start: event, uid });
      } else {
        segments.push({ start: event, uid: undefined });
      }
      this.browsers.set(cid, segments);
    }
  }

  /** A known uid keeps its original identity across devices. An anonymous segment
   * may join only its first subsequent login, known by goal time. Later logins
   * never reassign old anonymous exposures to another account.
   */
  matches(exposure: SubjectEvent, goal: SubjectEvent): boolean {
    if (compareEvents(exposure, goal) > 0) return false;
    if (exposure.subject.uid !== undefined) return exposure.subject.uid === goal.subject.uid;
    const segments = this.browsers.get(exposure.subject.cid);
    const exposureIndex = this.segmentIndex(segments, exposure);
    const segment = segments?.[exposureIndex];
    // An anonymous receipt shown inside a known authenticated interval is
    // ambiguous without its original session context. Do not guess its owner.
    if (segment?.uid !== undefined) return false;
    if (goal.subject.uid !== undefined) {
      const claim = segment?.claim;
      return claim !== undefined && claim.uid === goal.subject.uid && compareEvents(claim.at, goal) <= 0;
    }
    return exposure.subject.cid === goal.subject.cid
      && exposureIndex === this.segmentIndex(segments, goal);
  }

  /** Candidate index keys only; matches() remains the authority at goal time. */
  exposureKeys(exposure: SubjectEvent): readonly string[] {
    if (exposure.subject.uid !== undefined) return [this.goalKey(exposure.subject)];
    const segments = this.browsers.get(exposure.subject.cid);
    const segment = segments?.[this.segmentIndex(segments, exposure)];
    if (segment?.uid !== undefined) return [];
    const keys = [this.goalKey(exposure.subject)];
    if (segment?.claim) keys.push(JSON.stringify(['uid', segment.claim.uid]));
    return keys;
  }

  goalKey(subject: Subject): string {
    return JSON.stringify(subject.uid === undefined ? ['cid', subject.cid] : ['uid', subject.uid]);
  }

  private segmentIndex(segments: readonly Segment[] | undefined, at: Position): number {
    if (!segments) return 0;
    let lo = 1, hi = segments.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareEvents(segments[mid]!.start!, at) <= 0) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  }
}
