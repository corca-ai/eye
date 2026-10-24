import { createEyeRequest, type EyeOptions, type Subject } from '@eye/workers';

/** Store this immutable context with the committed order/outbox, not the webhook's cookies. */
export interface PaidOrderEvent {
  id: string;
  paidAt: number;
  amount: number;
  subject: Subject;
}

/** Invoke after verifying the provider webhook and committing payment in the service. */
export function reportPaidOrder(options: EyeOptions, event: PaidOrderEvent) {
  const eye = createEyeRequest({ ...options, subject: event.subject });
  return eye.goal({
    eventId: `purchase:${event.id}`, occurredAt: event.paidAt,
    goalId: 'purchase', value: event.amount,
  });
}
// Replays must reuse the same immutable event. accepted is not durable confirmation.
// Jobs needing Queue acknowledgement should use createEye + await flush() instead.
