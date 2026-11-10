import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { parseGoal, createBuyerAgent, checkStep } from '../src/buyerAgent.js';

test('reads the goal: what, how many, budget', () => {
  assert.deepEqual(parseGoal('Buy two green mugs as a gift, keep it under $30'), { query: 'green mug', qty: 2, budget: 30 });
  assert.deepEqual(parseGoal('a terracotta bowl'), { query: 'terracotta bowl', qty: 1, budget: null });
  assert.deepEqual(parseGoal('3 sand mugs, max $40.50'), { query: 'sand mug', qty: 3, budget: 40.5 });
});

let server, base;
before(async () => {
  const made = createApp({ env: { PAYPAL_MODE: 'mock' } });
  server = made.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = async (path, body) => {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Haggle-Agent': 'Demo buyer agent' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

async function shop(goal) {
  const steps = [];
  for (let i = 0; i < 12; i++) {
    const { body: step } = await post('/api/shops/ikoko/demo-buyer/step', { goal, steps });
    if (step.action === 'done') return { steps, done: step };
    const { status, body: result } = await post(`/api/shops/ikoko/tools/${step.action}`, step.args);
    assert.equal(status, 200, JSON.stringify(result));
    steps.push({ tool: step.action, args: step.args, result });
  }
  throw new Error('did not finish');
}

test('the rules buyer haggles two green mugs under $30 and stops at PayPal', async () => {
  const { steps, done } = await shop('Buy two green mugs as a gift, keep it under $30');
  const tools = steps.map((s) => s.tool);
  assert.deepEqual(tools.slice(0, 2), ['search_products', 'request_offer']);
  assert.equal(tools.at(-1), 'accept_offer');
  const order = steps.at(-1).result;
  assert.equal(order.status, 'awaiting_buyer_approval');
  assert.ok(order.total <= 30, `paid ${order.total}`);
  assert.ok(steps.filter((s) => s.tool === 'request_offer').length >= 2, 'it actually negotiated');
  assert.match(done.say, /PayPal/);
});

test('it stops instead of going over budget', async () => {
  const { steps, done } = await shop('one ochre vase, under $20');
  assert.ok(!steps.some((s) => s.tool === 'accept_offer'));
  assert.match(done.say, /budget|stopped/i);
});

test('it stops when the shop has nothing that fits', async () => {
  const { steps, done } = await shop('a blue teapot');
  assert.equal(steps.length, 1);
  assert.match(done.say, /doesn't have/);
});

test('the endpoint needs a goal and a real shop', async () => {
  assert.equal((await post('/api/shops/ikoko/demo-buyer/step', { goal: ' ' })).status, 400);
  assert.equal((await post('/api/shops/nope/demo-buyer/step', { goal: 'mug' })).status, 404);
});

test('DEMO_BUYER=off turns it off', async () => {
  const { app } = createApp({ env: { PAYPAL_MODE: 'mock', DEMO_BUYER: 'off' } });
  const s = app.listen(0);
  await new Promise((r) => s.once('listening', r));
  const res = await fetch(`http://127.0.0.1:${s.address().port}/api/shops/ikoko/demo-buyer/step`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"goal":"mug"}' });
  s.close();
  assert.equal(res.status, 404);
});

const fake = (obj) => ({ beta: { messages: { create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }] }) } } });

test('Claude cannot accept an offer the shop never made', async () => {
  const agent = createBuyerAgent({ client: fake({ action: 'accept_offer', offer_id: 'OFF-made-up', say: 'Done!' }) });
  const r = await agent({ shopName: 'x', goal: 'two green mugs under $30', steps: [] });
  assert.equal(r.action, 'done');
});

test('Claude cannot bid over the budget or accept an offer over it', async () => {
  const agent = createBuyerAgent({ client: fake({ action: 'request_offer', items: [{ sku: 'mug-green', qty: 2 }], bid: 50, say: 'Bidding' }) });
  const r = await agent({ shopName: 'x', goal: 'two green mugs under $30', steps: [] });
  assert.equal(r.args.bid, 30);
  const steps = [{ tool: 'request_offer', args: {}, result: { offerId: 'OFF-1', total: 34, status: 'final' } }];
  const blocked = checkStep('two green mugs under $30', steps, { action: 'accept_offer', args: { offer_id: 'OFF-1' }, say: '' });
  assert.equal(blocked.action, 'done');
});

test('errors, refusals and the hourly cap fall back to the rules', async () => {
  const broken = createBuyerAgent({ client: { beta: { messages: { create: async () => { throw new Error('down'); } } } } });
  assert.equal((await broken({ shopName: 'x', goal: 'green mug', steps: [] })).by, 'rules');
  const refusing = createBuyerAgent({ client: { beta: { messages: { create: async () => ({ stop_reason: 'refusal', content: [] }) } } } });
  assert.equal((await refusing({ shopName: 'x', goal: 'green mug', steps: [] })).by, 'rules');
  let calls = 0;
  const capped = createBuyerAgent({ maxModelSteps: 1, client: { beta: { messages: { create: async () => { calls++; return { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"action":"search_products","query":"mug","say":"Looking"}' }] }; } } } } });
  assert.equal((await capped({ shopName: 'x', goal: 'mug', steps: [] })).by, 'claude');
  assert.equal((await capped({ shopName: 'x', goal: 'mug', steps: [] })).by, 'rules');
  assert.equal(calls, 1);
});

test('a close-but-wrong match counts as missed demand', async () => {
  const { body } = await post('/api/shops/ikoko/tools/search_products', { query: 'green teapot' });
  assert.equal(body.match, 'close');
  const view = await (await fetch(`${base}/api/merchant/ikoko`)).json();
  assert.ok(view.missedDemand.some((m) => /green teapot/.test(m.what)), JSON.stringify(view.missedDemand));
});
