import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The exact JSON `createCheckout` puts on the wire.
 *
 * Every other billing suite mocks this module out, which means the request body
 * itself has no coverage at all — and `checkout_options.skip_trial` is the kind
 * of field that fails silently when it is nested in the wrong place. LemonSqueezy
 * ignores attributes it does not recognise, so a misplaced `skip_trial` would
 * not error: it would hand a free trial to every repeat buyer, and every test
 * that asserts our *intent* would still pass.
 *
 * So this suite asserts placement against a stubbed `fetch`, not behaviour.
 */
process.env.LEMONSQUEEZY_API_KEY = "test-api-key";
process.env.LEMONSQUEEZY_STORE_ID = "42";
process.env.LEMONSQUEEZY_WEBHOOK_SECRET = "test-signing-secret";

const ls = await import("../src/services/lemonSqueezy.client.js");

interface CheckoutBody {
  data: {
    type: string;
    attributes: {
      checkout_data?: { email?: string; name?: string; custom?: { user_id?: string } };
      checkout_options?: { skip_trial?: boolean };
      product_options?: { redirect_url?: string };
      expires_at?: string;
    };
    relationships: {
      store: { data: { id: string } };
      variant: { data: { id: string } };
    };
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { id: "1", type: "checkouts", attributes: { url: "https://co/x" } } }),
  }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The parsed body of the request the client actually made. */
function sentBody(): CheckoutBody {
  const init = fetchMock.mock.calls[0][1] as { body: string };
  return JSON.parse(init.body) as CheckoutBody;
}

const INPUT = {
  variantId: "1001",
  userId: "6a7bb8dfc37a5bb33812fdca",
  email: "student@example.com",
  name: "A Student",
  redirectUrl: "https://app.example/account/plans?checkout=success",
};

describe("createCheckout request body", () => {
  it("puts skip_trial inside checkout_options, where LemonSqueezy reads it", async () => {
    await ls.createCheckout({ ...INPUT, skipTrial: true });

    const body = sentBody();
    expect(body.data.attributes.checkout_options?.skip_trial).toBe(true);
    // Not smuggled in somewhere harmless-looking that would be ignored.
    expect(body.data.attributes).not.toHaveProperty("skip_trial");
    expect(body.data.attributes.product_options).not.toHaveProperty("skip_trial");
    expect(body.data.attributes.checkout_data).not.toHaveProperty("skip_trial");
  });

  it("sends skip_trial:false when the trial is being granted", async () => {
    // Explicit rather than absent, so the intent is visible in the request and
    // a reader does not have to know LemonSqueezy's default.
    await ls.createCheckout({ ...INPUT, skipTrial: false });
    expect(sentBody().data.attributes.checkout_options?.skip_trial).toBe(false);
  });

  it("defaults to skipping when the caller says nothing", async () => {
    // `skipTrial` is required, so the compiler already stops this — the cast is
    // standing in for a caller it cannot see (plain JS, a future refactor that
    // drops the field). The runtime default has to take the cheap mistake:
    // withholding a trial costs a conversion, granting one by accident gives
    // away a free period to everyone who finds it.
    await ls.createCheckout(INPUT as Parameters<typeof ls.createCheckout>[0]);
    expect(sentBody().data.attributes.checkout_options?.skip_trial).toBe(true);
  });

  it("still carries the user id that links a payment back to an account", async () => {
    // The whole basis of trusting a webhook's identity claim. Asserted here
    // because it travels in the same attributes object skip_trial was added to.
    await ls.createCheckout({ ...INPUT, skipTrial: true });

    const body = sentBody();
    expect(body.data.attributes.checkout_data?.custom?.user_id).toBe(INPUT.userId);
    expect(body.data.relationships.variant.data.id).toBe("1001");
    expect(body.data.relationships.store.data.id).toBe("42");
  });
});
