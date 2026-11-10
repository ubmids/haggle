// PayPal Orders v2, sandbox only. Live hosts are refused in code, not just config.
//
// PAYPAL_MODE=sandbox (default when credentials are set) talks to api-m.sandbox.paypal.com.
// PAYPAL_MODE=mock needs no account: orders are simulated and approved on a local page,
// so the repo runs for anyone. Mock orders are labelled as such everywhere they appear.

import { randomUUID } from 'node:crypto';

export const SANDBOX_API = 'https://api-m.sandbox.paypal.com';

export function assertSandbox(base) {
  const host = new URL(base).host;
  if (host !== 'api-m.sandbox.paypal.com') {
    throw new Error(`Refusing to talk to ${host}: haggle only runs against PayPal's sandbox.`);
  }
}

const money = (currency, value) => ({ currency_code: currency, value: Number(value).toFixed(2) });

/** Build the Orders v2 body from an agreed offer. Exported for tests. */
export function orderBody(offer) {
  const { currency, allocation } = offer;
  return {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: offer.id,
        custom_id: offer.id,
        description: `${offer.shopName}: deal agreed with an AI agent`.slice(0, 127),
        amount: {
          ...money(currency, allocation.total),
          breakdown: {
            item_total: money(currency, allocation.itemTotal),
            ...(allocation.discount > 0 ? { discount: money(currency, allocation.discount) } : {}),
          },
        },
        items: allocation.lines.map((l) => ({
          name: l.name.slice(0, 127),
          sku: l.sku,
          quantity: String(l.qty),
          unit_amount: money(currency, l.unitPrice),
          category: 'PHYSICAL_GOODS',
        })),
      },
    ],
    application_context: {
      brand_name: offer.shopName.slice(0, 127),
      shipping_preference: 'NO_SHIPPING',
      user_action: 'PAY_NOW',
      return_url: offer.returnUrl,
      cancel_url: offer.cancelUrl,
    },
  };
}

export function createPayPal({ mode, clientId, clientSecret, base = SANDBOX_API, fetchImpl = fetch, publicUrl = '' } = {}) {
  const resolvedMode = mode ?? (clientId && clientSecret ? 'sandbox' : 'mock');
  if (resolvedMode === 'mock') return createMock(publicUrl);
  if (!clientId || !clientSecret) throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are needed for sandbox mode');
  assertSandbox(base);

  let token = null;
  let tokenExpires = 0;

  async function accessToken() {
    if (token && Date.now() < tokenExpires - 60_000) return token;
    const res = await fetchImpl(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw new Error(`PayPal auth failed (${res.status})`);
    const json = await res.json();
    token = json.access_token;
    tokenExpires = Date.now() + json.expires_in * 1000;
    return token;
  }

  async function call(method, path, body, idempotencyKey) {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'PayPal-Request-Id': idempotencyKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = json?.details?.[0]?.issue ?? json?.name ?? res.status;
      const err = new Error(`PayPal ${method} ${path} failed: ${detail}`);
      err.status = res.status;
      err.paypal = json;
      throw err;
    }
    return json;
  }

  return {
    mode: 'sandbox',
    clientId,
    async createOrder(offer) {
      const json = await call('POST', '/v2/checkout/orders', orderBody(offer), `haggle-${offer.id}`);
      const approve = json.links?.find((l) => l.rel === 'approve' || l.rel === 'payer-action');
      return { id: json.id, status: json.status, approveUrl: approve?.href ?? null };
    },
    async getOrder(id) {
      const json = await call('GET', `/v2/checkout/orders/${encodeURIComponent(id)}`);
      return { id: json.id, status: json.status, payer: json.payer?.email_address ?? null };
    },
    async captureOrder(id) {
      const json = await call('POST', `/v2/checkout/orders/${encodeURIComponent(id)}/capture`, {}, `haggle-capture-${id}`);
      const capture = json.purchase_units?.[0]?.payments?.captures?.[0];
      return { id: json.id, status: json.status, captureId: capture?.id ?? null };
    },
  };
}

function createMock(publicUrl) {
  const orders = new Map();
  return {
    mode: 'mock',
    clientId: null,
    async createOrder(offer) {
      const id = 'MOCK-' + randomUUID().slice(0, 13).toUpperCase();
      orders.set(id, { id, status: 'CREATED', offerId: offer.id, total: offer.allocation.total });
      return { id, status: 'CREATED', approveUrl: `${publicUrl}/mock-paypal/${id}` };
    },
    async getOrder(id) {
      const o = orders.get(id);
      if (!o) throw Object.assign(new Error('unknown order'), { status: 404 });
      return { id, status: o.status, payer: o.status === 'CREATED' ? null : 'sandbox-buyer@example.com' };
    },
    async captureOrder(id) {
      const o = orders.get(id);
      if (!o) throw Object.assign(new Error('unknown order'), { status: 404 });
      if (o.status !== 'APPROVED') throw Object.assign(new Error('ORDER_NOT_APPROVED'), { status: 422 });
      o.status = 'COMPLETED';
      return { id, status: 'COMPLETED', captureId: 'MOCKCAP-' + id.slice(5) };
    },
    approve(id) {
      const o = orders.get(id);
      if (!o) return false;
      if (o.status === 'CREATED') o.status = 'APPROVED';
      return true;
    },
    peek: (id) => orders.get(id),
  };
}
