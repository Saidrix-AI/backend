import { Schema, model, type InferSchemaType } from "mongoose";

/**
 * The idempotency ledger for incoming LemonSqueezy webhooks.
 *
 * LemonSqueezy retries any non-2xx response three times with exponential
 * backoff and sends **no webhook id of its own** — the payload carries only
 * `meta.event_name` and the object. So the key is composed at the door:
 *
 *     `${event_name}:${data.id}:${data.attributes.updated_at}`
 *
 * Inserting it is the guard: a duplicate key means this exact event has already
 * been applied, and the handler stops before touching a subscription. The
 * insert happens *before* processing, so a crash mid-handler cannot be replayed
 * either — the recovery path for that is `POST /api/billing/sync`, which reads
 * the live state from LemonSqueezy rather than replaying an event.
 *
 * Rows expire after 30 days. Retries are all over within minutes, so anything
 * older can only be a replayed request, which by then is a different problem.
 */
const webhookEventSchema = new Schema({
  eventKey: { type: String, required: true, unique: true },
  eventName: { type: String, required: true },
  /** Kept for support: "which events did we actually receive for this order?" */
  objectId: { type: String, default: "" },
  receivedAt: { type: Date, default: Date.now },
});

webhookEventSchema.index({ receivedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export type WebhookEvent = InferSchemaType<typeof webhookEventSchema>;
export const WebhookEventModel = model("WebhookEvent", webhookEventSchema);
