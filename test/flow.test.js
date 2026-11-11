import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

let server, base, paypal;

before(async () => {
  const made = createApp({ env: { PAYPAL_MODE: 'mock' } });
  paypal = made.paypal;
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const tool = async (name, args, agent = 'test agent') => {
  const res = await fetch(`${base}/api/shops/ikoko/tools/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Haggle-Agent': agent },
    body: JSON.stringify(args),
  });
  return { status: res.status, body: await res.json() };
};

test('search never leaks floor prices', async () => {
  const { body } = await tool('search_products', { query: 'green mug' });
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].sku, 'mug-green');
  assert.equal('floor' in body.results[0], false);
  assert.doesNotMatch(JSON.stringify(body), /floor/);
});

test('max_price filters, and misses are logged as demand', async () => {
  const cheap = await tool('search_products', { query: 'mug', max_price: 17 });
  assert.deepEqual(cheap.body.results.map((r) => r.sku), ['mug-sand']);
  const miss = await tool('search_products', { query: 'teapot' });
  assert.equal(miss.body.results.length, 0);
  const view = await (await fetch(`${base}/api/merchant/ikoko`)).json();
  assert.ok(view.missedDemand.some((m) => m.what.includes('teapot')));
});

test('haggle, accept, approve in (mock) PayPal, then paid', async () => {
  const items = [{ sku: 'mug-green', qty: 2 }];
  const q = await tool('request_offer', { items });
  assert.equal(q.body.total, 36);
  const r1 = await tool('request_offer', { items, bid: 26, negotiation_id: q.body.negotiationId });
  assert.equal(r1.body.status, 'counter');
  assert.ok(r1.body.total < 36 && r1.body.total >= 24);
  const r2 = await tool('request_offer', { items, bid: 28, negotiation_id: r1.body.negotiationId });
  assert.equal(r2.body.status, 'accepted');
  assert.equal(r2.body.total, 28);
  assert.equal(r2.body.savings, 8);

  const acc = await tool('accept_offer', { offer_id: r2.body.offerId });
  assert.equal(acc.body.status, 'awaiting_buyer_approval');
  assert.match(acc.body.approveUrl, /mock-paypal/);

  const before = await tool('check_order', { order_id: acc.body.orderId });
  assert.equal(before.body.status, 'awaiting_buyer_approval');

  // The person approves. The agent has no way to do this step.
  paypal.approve(acc.body.orderId);
  const paid = await tool('check_order', { order_id: acc.body.orderId });
  assert.equal(paid.body.status, 'paid');
  assert.equal(paid.body.total, 28);

  const view = await (await fetch(`${base}/api/merchant/ikoko`)).json();
  const order = view.orders.find((o) => o.orderId === acc.body.orderId);
  assert.equal(order.placedBy, 'agent');
  assert.equal(order.agent, 'test agent');
  assert.equal(view.products.find((p) => p.sku === 'mug-green').stock, 12);
});

test('accepting the same offer twice does not create two orders', async () => {
  const r = await tool('request_offer', { items: [{ sku: 'mug-sand', qty: 1 }], bid: 16 });
  const a = await tool('accept_offer', { offer_id: r.body.offerId });
  const b = await tool('accept_offer', { offer_id: r.body.offerId });
  assert.equal(a.body.orderId, b.body.orderId);
});

test('agent cannot set a price by inventing an offer or a cart', async () => {
  const fake = await tool('accept_offer', { offer_id: 'OFF-FAKE' });
  assert.equal(fake.status, 404);
  const ghost = await tool('request_offer', { items: [{ sku: 'gold-bar', qty: 1 }], bid: 1 });
  assert.equal(ghost.body.status, 'unavailable');
  const greedy = await tool('request_offer', { items: [{ sku: 'vase-ochre', qty: 99 }], bid: 1 });
  assert.equal(greedy.body.error, 'out_of_stock');
});

test('a declined lowball returns no offer to accept', async () => {
  const items = [{ sku: 'plate-ash', qty: 2 }];
  let neg;
  let last;
  for (let i = 0; i < 4; i++) {
    last = await tool('request_offer', { items, bid: 5, negotiation_id: neg });
    neg = last.body.negotiationId;
  }
  assert.equal(last.body.status, 'declined');
  assert.equal(last.body.offerId, null);
  assert.ok(last.body.total >= 42);
});

test('merchant can change a floor, within list price', async () => {
  const ok = await fetch(`${base}/api/merchant/ikoko/floor`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sku: 'bowl-terracotta', floor: 20 }) });
  assert.equal(ok.status, 200);
  const bad = await fetch(`${base}/api/merchant/ikoko/floor`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sku: 'bowl-terracotta', floor: 99 }) });
  assert.equal(bad.status, 400);
});

test('the script tag and shop page are served, with CORS for the tool API', async () => {
  const js = await fetch(`${base}/haggle.js`);
  assert.equal(js.status, 200);
  assert.match(await js.text(), /registerTool/);
  const shop = await fetch(`${base}/`);
  assert.match(await shop.text(), /<script src="\/haggle.js" data-shop="ikoko" defer><\/script>/);
  const pre = await fetch(`${base}/api/shops/ikoko/tools/search_products`, { method: 'OPTIONS' });
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
});

test('offers say who worded them, and the merchant view names products', async () => {
  const items = [{ sku: 'bowl-terracotta', qty: 1 }];
  const r = await tool('request_offer', { items, bid: 20 });
  assert.equal(r.body.wordedBy, 'rules');
  const view = await (await fetch(`${base}/api/merchant/ikoko`)).json();
  const neg = view.negotiations.find((n) => n.id === r.body.negotiationId);
  assert.equal(neg.items, '1× Terracotta soup bowl');
});
