import { createEyeRequest, type EyeOptions, type Subject } from '@eye/workers';

/** Store this immutable context with the committed order/outbox, not the webhook's cookies. */
export interface PaidOrderEvent {
  id: string;
  paidAt: number;
  amount: number;
  subject: Subject;
}

/** Invoke after verifying the provider webhook and committing payment in the service.
 * The original paidAt must be within 15 seconds at SDK and Worker admission.
 * Delayed webhooks/outbox replays are rejected; never restamp them as new goals. */
export function reportPaidOrder(options: EyeOptions, event: PaidOrderEvent) {
  const eye = createEyeRequest({ ...options, subject: event.subject });
  return eye.goal({
    eventId: `purchase:${event.id}`, occurredAt: event.paidAt,
    goalId: 'purchase', value: event.amount,
  });
}
// Replays within the 15-second admission window must reuse the same immutable event.
// accepted is not durable confirmation; Queue retries preserve server receipt time.
// Jobs needing Queue acknowledgement should use createEye + await flush() instead.
