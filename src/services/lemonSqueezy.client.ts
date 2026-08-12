import { env, isBillingEnabled } from "../config/env.js";
import { ApiError } from "../utils/apiError.js";
import { logger } from "../utils/logger.js";

/**
 * A thin client for the four LemonSqueezy endpoints this app uses.
 *
 * Hand-rolled rather than pulling in @lmsqueezy/lemonsqueezy.js: the surface is
 * four calls over plain fetch, and the SDK's value is the typings for endpoints
 * we do not touch.
 *
 * The API is JSON:API, so every request and response is wrapped in
 * `data.attributes` and needs the `application/vnd.api+json` content type —
 * sending plain `application/json` is rejected.
 *
 * The API key is a bearer secret with full store access. It is read here and
 * nowhere else, and never appears in a log line or an error message.
 */

const API_BASE = "https://api.lemonsqueezy.com/v1";
const JSON_API = "application/vnd.api+json";
/** LemonSqueezy allows 300 calls/minute; a single 429 is worth one retry. */
const RETRY_DELAY_MS = 1_500;
const REQUEST_TIMEOUT_MS = 15_000;

/** The JSON:API envelope, narrowed only where we actually read it. */
export interface LsResource<A = Record<string, unknown>> {
  type: string;
  id: string;
  attributes: A;
}

export interface LsSubscriptionAttributes {
  store_id?: number | string;
  customer_id?: number | string;
  order_id?: number | string;
  product_id?: number | string;
  variant_id?: number | string;
  user_name?: string;
  user_email?: string;
  status?: string;
  status_formatted?: string;
  card_brand?: string;
  card_last_four?: string;
  pause?: { mode?: string; resumes_at?: string | null } | null;
  cancelled?: boolean;
  trial_ends_at?: string | null;
  renews_at?: string | null;
  ends_at?: string | null;
  created_at?: string;
  updated_at?: string;
  test_mode?: boolean;
  urls?: { update_payment_method?: string; customer_portal?: string } | null;
}

export type LsSubscription = LsResource<LsSubscriptionAttributes>;

/**
 * A subscription invoice. Same attribute names the payment webhooks carry, so
 * one recorder handles both sources.
 */
export interface LsInvoiceAttributes {
  store_id?: number | string;
  subscription_id?: number | string;
  customer_id?: number | string;
  user_email?: string;
  billing_reason?: string;
  card_brand?: string;
  card_last_four?: string;
  currency?: string;
  status?: string;
  refunded?: boolean;
  refunded_amount?: number;
  subtotal?: number;
  discount_total?: number;
  tax?: number;
  total?: number;
  total_formatted?: string;
  urls?: { invoice_url?: string } | null;
  created_at?: string;
  updated_at?: string;
  test_mode?: boolean;
}

export type LsInvoice = LsResource<LsInvoiceAttributes>;

function assertConfigured(): void {
  if (!isBillingEnabled()) {
    // 503, not 500: nothing is broken, the deployment simply has no billing
    // keys — a state local development runs in on purpose.
    throw new ApiError(503, "Billing is not configured on this server.");
  }
}

async function call<T>(
  path: string,
  init: { method: string; body?: unknown },
  retried = false,
): Promise<T> {
  assertConfigured();

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: init.method,
      headers: {
        Accept: JSON_API,
        "Content-Type": JSON_API,
        Authorization: `Bearer ${env.LEMONSQUEEZY_API_KEY}`,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    logger.error({ path, err: (err as Error)?.message }, "[lemonsqueezy] request failed");
    throw new ApiError(502, "Could not reach the payment provider. Please try again.");
  }

  if (res.status === 429 && !retried) {
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    return call<T>(path, init, true);
  }

  if (!res.ok) {
    // Their error body names the failing attribute, which is what makes a
    // misconfigured variant id debuggable. It is logged, never returned: it can
    // echo the request, and the request carries the store id.
    const detail = await res.text().catch(() => "");
    logger.error({ path, status: res.status, detail: detail.slice(0, 500) }, "[lemonsqueezy] error");
    throw new ApiError(
      res.status === 404 ? 404 : 502,
      res.status === 404
        ? "That subscription no longer exists at the payment provider."
        : "The payment provider rejected the request. Please try again.",
    );
  }

  return (await res.json()) as T;
}

export interface CreateCheckoutInput {
  variantId: string;
  /** Our user id. Comes back as `meta.custom_data.user_id` on every webhook. */
  userId: string;
  email: string;
  name: string;
  redirectUrl: string;
  /** Minutes until the generated URL stops working. */
  expiresInMinutes?: number;
  /**
   * Sell this variant WITHOUT its free trial, charging immediately.
   *
   * The Basic variants carry a 1-day trial in the dashboard, which would
   * otherwise be handed to everyone who buys them, every time. This is how a
   * second trial is refused to someone who has already had one.
   *
   * Required, deliberately: granting a free period is not something any caller
   * should be able to do by forgetting a field. It also defaults to `true` at
   * runtime, so a caller the compiler cannot see withholds the trial rather
   * than giving one away.
   */
  skipTrial: boolean;
}

/**
 * Creates a one-off checkout URL for one buyer.
 *
 * `custom.user_id` is the whole link between a payment and an account: it is
 * set here by the server, echoed back inside the HMAC-signed webhook, and is
 * therefore as trustworthy as the signature itself. It is never shown to the
 * customer and never read from client input.
 *
 * The URL expires, so one left in a browser history cannot be handed around.
 */
export async function createCheckout(input: CreateCheckoutInput): Promise<string> {
  const expiresAt = new Date(
    Date.now() + (input.expiresInMinutes ?? 30) * 60 * 1000,
  ).toISOString();

  const body = {
    data: {
      type: "checkouts",
      attributes: {
        checkout_data: {
          email: input.email,
          name: input.name,
          custom: { user_id: input.userId },
        },
        product_options: {
          redirect_url: input.redirectUrl,
          receipt_button_text: "Go to Saidrix",
        },
        // Sent on every checkout rather than only when skipping, so the
        // decision is always explicit in the request. `false` is LemonSqueezy's
        // own default and simply honours whatever the variant is configured
        // with.
        //
        // Anything other than an explicit `false` skips the trial. The two
        // mistakes are not equally bad — withholding a trial costs a
        // conversion, granting one by accident gives away a free period to
        // everyone who finds it — so the ambiguous case takes the cheap one.
        checkout_options: {
          skip_trial: input.skipTrial !== false,
        },
        expires_at: expiresAt,
      },
      relationships: {
        store: { data: { type: "stores", id: String(env.LEMONSQUEEZY_STORE_ID) } },
        variant: { data: { type: "variants", id: String(input.variantId) } },
      },
    },
  };

  const json = await call<{ data: LsResource<{ url?: string }> }>("/checkouts", {
    method: "POST",
    body,
  });
  const url = json.data?.attributes?.url;
  if (!url) throw new ApiError(502, "The payment provider did not return a checkout link.");
  return url;
}

/** One subscription by id. The response carries freshly signed portal URLs. */
export async function getSubscription(subscriptionId: string): Promise<LsSubscription> {
  const json = await call<{ data: LsSubscription }>(`/subscriptions/${subscriptionId}`, {
    method: "GET",
  });
  return json.data;
}

/**
 * Every subscription belonging to an email address, newest first.
 *
 * The recovery path when a webhook was missed for an account that has no
 * subscription row yet — there is no local id to look up, so the email is the
 * only handle we have.
 */
export async function listSubscriptionsByEmail(email: string): Promise<LsSubscription[]> {
  const params = new URLSearchParams({
    "filter[store_id]": String(env.LEMONSQUEEZY_STORE_ID),
    "filter[user_email]": email,
  });
  const json = await call<{ data: LsSubscription[] }>(`/subscriptions?${params}`, {
    method: "GET",
  });
  return json.data ?? [];
}

/**
 * Every invoice raised against one subscription, newest first.
 *
 * The receipts half of the dropped-webhook recovery: `getSubscription` restores
 * what the customer is entitled to, this restores what they were charged.
 *
 * One page is deliberate. 50 monthly invoices is four years of history, and the
 * rows this backfills are a convenience — the authoritative record lives at
 * LemonSqueezy, reachable from the customer portal.
 */
export async function listSubscriptionInvoices(subscriptionId: string): Promise<LsInvoice[]> {
  const params = new URLSearchParams({
    "filter[subscription_id]": String(subscriptionId),
    "page[size]": "50",
  });
  const json = await call<{ data: LsInvoice[] }>(`/subscription-invoices?${params}`, {
    method: "GET",
  });
  return json.data ?? [];
}

/**
 * Cancels a subscription.
 *
 * `DELETE` is LemonSqueezy's verb for this, but nothing is deleted: the response
 * is the same subscription in `cancelled` state with `ends_at` set to the end of
 * the period already paid for. That response is what lets the caller update our
 * mirror in the same request instead of waiting on a webhook.
 *
 * The customer keeps their access until `ends_at` — see `accessFor`, which maps
 * a cancelled subscription to `grace` until that date passes.
 */
export async function cancelSubscription(subscriptionId: string): Promise<LsSubscription> {
  const json = await call<{ data: LsSubscription }>(`/subscriptions/${subscriptionId}`, {
    method: "DELETE",
  });
  return json.data;
}

/**
 * Moves a subscription to another variant (tier or billing period).
 *
 * Not currently called: plan changes are routed through the LemonSqueezy
 * customer portal, which does the same thing with a UI for the proration
 * charge. Kept because an in-app upgrade button is the obvious next step and
 * this is the one call it needs.
 */
export async function updateSubscriptionVariant(
  subscriptionId: string,
  variantId: string,
): Promise<LsSubscription> {
  const json = await call<{ data: LsSubscription }>(`/subscriptions/${subscriptionId}`, {
    method: "PATCH",
    body: {
      data: {
        type: "subscriptions",
        id: String(subscriptionId),
        attributes: { variant_id: Number(variantId) },
      },
    },
  });
  return json.data;
}
