import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShopAgent } from '../src/shopAgent.js';
import { priceCart, decide } from '../src/negotiate.js';

const catalog = [{ sku: 'mug-green', name: 'Moss green mug', price: 18, floor: 12, stock: 10, currency: 'USD' }];
const cart = priceCart(catalog, [{ sku: 'mug-green', qty: 2 }]);

function fakeClient(reply) {
  return { beta: { messages: { create: async () => reply } } };
}

test('without a client, the rules engine words the reply', async () => {
  const agent = createShopAgent({ client: null });
  const d = decide(cart, {}, 26);
  const r = await agent({ shopName: 'Ìkòkò', cart, decision: d });
  assert.equal(r.by, 'rules');
  assert.equal(r.total, d.total);
  assert.match(r.message, /\$31\.00/);
});

test('a model that tries to go under the floor is clamped back up', async () => {
  const client = fakeClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ total: 3, message: 'Practically free!' }) }] });
  const agent = createShopAgent({ client });
  const d = decide(cart, {}, 5);
  const r = await agent({ shopName: 'Ìkòkò', cart, decision: d });
  assert.equal(r.by, 'claude');
  assert.ok(r.total >= cart.floorTotal);
});

test('a model that tries to charge above the counter is held to it', async () => {
  const client = fakeClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ total: 999, message: 'Premium!' }) }] });
  const agent = createShopAgent({ client });
  const d = decide(cart, { round: 2, lastCounter: 26 }, 5); // final round
  const r = await agent({ shopName: 'Ìkòkò', cart, decision: d });
  assert.equal(r.total, d.total);
});

test('refusals and errors fall back to the rules', async () => {
  const refusing = createShopAgent({ client: fakeClient({ stop_reason: 'refusal', content: [] }) });
  const broken = createShopAgent({ client: { beta: { messages: { create: async () => { throw new Error('down'); } } } } });
  const d = decide(cart, {}, 26);
  assert.equal((await refusing({ shopName: 'x', cart, decision: d })).by, 'rules');
  assert.equal((await broken({ shopName: 'x', cart, decision: d })).by, 'rules');
});

test('accepted deals never go through the model', async () => {
  let called = false;
  const agent = createShopAgent({ client: { beta: { messages: { create: async () => { called = true; } } } } });
  await agent({ shopName: 'x', cart, decision: decide(cart, {}, 40) });
  assert.equal(called, false);
});
