// Loads public/haggle.js into a fake page with a fake WebMCP registry, the way
// Chrome or ChatGPT's browser would, and drives a whole purchase through the
// registered tools' execute() callbacks.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
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

async function loadPage({ withWebMCP = true, api = 'document' } = {}) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body><h1>Plain shop</h1></body></html>`, {
    url: `${base}/shop`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const registry = new Map();
  const mc = {
    registerTool(def, opts) {
      assert.equal(typeof def.execute, 'function');
      registry.set(def.name, def);
      opts?.signal?.addEventListener('abort', () => registry.delete(def.name));
    },
  };
  if (withWebMCP) {
    if (api === 'document') window.document.modelContext = mc;
    else window.navigator.modelContext = mc;
  }
  window.fetch = (url, init) => fetch(new URL(url, base), init);
  const src = await readFile(new URL('../public/haggle.js', import.meta.url), 'utf8');
  const el = window.document.createElement('script');
  el.src = `${base}/haggle.js`;
  el.dataset.shop = 'ikoko';
  Object.defineProperty(window.document, 'currentScript', { value: el, configurable: true });
  window.eval(src);
  return { window, registry };
}

const run = async (registry, name, args) => {
  const out = await registry.get(name).execute(args);
  return JSON.parse(out.content[0].text);
};

test('registers the five tools on document.modelContext', async () => {
  const { registry, window } = await loadPage();
  assert.deepEqual([...registry.keys()], ['search_products', 'get_product', 'request_offer', 'accept_offer', 'check_order']);
  assert.equal(window.haggle.webmcp, true);
  assert.equal(registry.get('search_products').annotations.readOnlyHint, true);
  assert.equal(registry.get('request_offer').inputSchema.required[0], 'items');
  assert.ok(window.document.querySelector('.hg-badge'), 'shows the agent-ready badge');
});

test('falls back to the older navigator.modelContext', async () => {
  const { registry } = await loadPage({ api: 'navigator' });
  assert.equal(registry.size, 5);
});

test('without WebMCP it still exposes window.haggle and says WebMCP is off', async () => {
  const { window, registry } = await loadPage({ withWebMCP: false });
  assert.equal(registry.size, 0);
  assert.equal(window.haggle.webmcp, false);
  assert.match(window.document.querySelector('.hg-pill').textContent, /WebMCP off/);
  const r = await window.haggle.call('search_products', { query: 'vase' });
  assert.equal(r.results[0].sku, 'vase-ochre');
});

test('an agent buys two green mugs under $30 through the registered tools', async () => {
  const { registry, window } = await loadPage();
  const found = await run(registry, 'search_products', { query: 'green mug' });
  const sku = found.results[0].sku;
  const items = [{ sku, qty: 2 }];
  const first = await run(registry, 'request_offer', { items, bid: 25, message: 'Buying two as a gift, budget is $30.' });
  assert.equal(first.status, 'counter');
  const second = await run(registry, 'request_offer', { items, bid: 29, negotiation_id: first.negotiationId });
  assert.equal(second.status, 'accepted');
  assert.ok(second.total < 30);

  const order = await run(registry, 'accept_offer', { offer_id: second.offerId });
  assert.equal(order.status, 'awaiting_buyer_approval');
  await new Promise((r) => setTimeout(r, 50));
  const sheet = window.document.querySelector('.hg-sheet');
  assert.ok(sheet, 'shows the PayPal approval sheet to the person');
  assert.match(sheet.textContent, /You save/);

  paypal.approve(order.orderId);
  const paid = await run(registry, 'check_order', { order_id: order.orderId });
  assert.equal(paid.status, 'paid');

  const rows = [...window.document.querySelectorAll('.hg-row')].map((r) => r.textContent);
  assert.ok(rows.some((t) => /shop countered/.test(t)), rows.join('\n'));
  assert.ok(rows.some((t) => /order paid/.test(t)), rows.join('\n'));
});
