import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPayPal, orderBody, assertSandbox } from '../src/paypal.js';

const offer = {
  id: 'OFF-1', shopName: 'Test Shop', currency: 'USD',
  allocation: { itemTotal: 36, discount: 8, total: 28, lines: [{ sku: 'mug-green', name: 'Moss green mug', qty: 2, unitPrice: 18 }] },
  returnUrl: 'https://x.test/checkout/return', cancelUrl: 'https://x.test/checkout/cancel',
};

test('refuses live PayPal hosts', () => {
  assert.throws(() => assertSandbox('https://api-m.paypal.com'), /sandbox/);
  assert.throws(() => createPayPal({ clientId: 'a', clientSecret: 'b', base: 'https://api-m.paypal.com' }), /sandbox/);
  assert.doesNotThrow(() => assertSandbox('https://api-m.sandbox.paypal.com'));
});

test('order body adds up: item_total minus discount equals amount', () => {
  const b = orderBody(offer);
  const pu = b.purchase_units[0];
  assert.equal(pu.amount.value, '28.00');
  assert.equal(pu.amount.breakdown.item_total.value, '36.00');
  assert.equal(pu.amount.breakdown.discount.value, '8.00');
  assert.equal(pu.items[0].quantity, '2');
  assert.equal(pu.items[0].unit_amount.value, '18.00');
  assert.equal(pu.custom_id, 'OFF-1');
});

test('sandbox client: token, create with idempotency key, capture', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/v1/oauth2/token')) return new Response(JSON.stringify({ access_token: 'T', expires_in: 3600 }));
    if (url.endsWith('/v2/checkout/orders')) {
      return new Response(JSON.stringify({ id: 'PP1', status: 'CREATED', links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=PP1' }] }), { status: 201 });
    }
    if (url.endsWith('/capture')) {
      return new Response(JSON.stringify({ id: 'PP1', status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAP1' }] } }] }), { status: 201 });
    }
    return new Response('{}', { status: 404 });
  };
  const pp = createPayPal({ clientId: 'id', clientSecret: 'secret', fetchImpl });
  assert.equal(pp.mode, 'sandbox');
  const o = await pp.createOrder(offer);
  assert.equal(o.approveUrl, 'https://www.sandbox.paypal.com/checkoutnow?token=PP1');
  const create = calls.find((c) => c.url.endsWith('/v2/checkout/orders'));
  assert.equal(create.init.headers['PayPal-Request-Id'], 'haggle-OFF-1');
  assert.equal(create.init.headers.Authorization, 'Bearer T');
  const cap = await pp.captureOrder('PP1');
  assert.equal(cap.captureId, 'CAP1');
  assert.equal(calls.filter((c) => c.url.endsWith('/v1/oauth2/token')).length, 1, 'token is cached');
});

test('mock client: capture fails until approved', async () => {
  const pp = createPayPal({ mode: 'mock' });
  const o = await pp.createOrder(offer);
  await assert.rejects(pp.captureOrder(o.id), /NOT_APPROVED/);
  pp.approve(o.id);
  assert.equal((await pp.captureOrder(o.id)).status, 'COMPLETED');
});
