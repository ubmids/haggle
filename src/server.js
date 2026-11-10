import express from 'express';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { SHOPS } from './shops.js';
import { createPayPal } from './paypal.js';
import { createShopAgent } from './shopAgent.js';
import { createService } from './service.js';
import { createBuyerAgent, cleanSteps } from './buyerAgent.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, '..', 'public');

export function createApp({ env = process.env, shops = structuredClone(SHOPS), paypal, shopAgent, buyerAgent } = {}) {
  // On Vercel the production address is known without setting PUBLIC_URL.
  const vercelUrl = env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : '';
  const publicUrl = (env.PUBLIC_URL || vercelUrl).replace(/\/$/, '');
  paypal ??= createPayPal({
    mode: env.PAYPAL_MODE,
    clientId: env.PAYPAL_CLIENT_ID,
    clientSecret: env.PAYPAL_CLIENT_SECRET,
    publicUrl,
  });
  const hasClaude = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
  shopAgent ??= createShopAgent({ client: hasClaude ? new Anthropic() : null, model: env.HAGGLE_MODEL });
  const svc = createService({ shops, paypal, shopAgent, publicUrl });
  // The demo buyer can be turned off with DEMO_BUYER=off, e.g. on a real merchant's host.
  const demoBuyer = env.DEMO_BUYER !== 'off';
  buyerAgent ??= createBuyerAgent({ client: hasClaude && buyerUsesClaude(env) ? new Anthropic() : null, model: env.HAGGLE_MODEL });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));

  // The script tag runs on the merchant's own site, so the tool API is cross-origin.
  app.use('/api/shops', (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-Haggle-Agent');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  const wrap = (fn) => async (req, res) => {
    try {
      res.json(await fn(req, res));
    } catch (e) {
      res.status(e.status ?? 500).json({ error: e.message });
    }
  };

  app.get('/api/shops/:shop/config', wrap(async (req) => {
    const s = shops[req.params.shop];
    if (!s) throw Object.assign(new Error('unknown_shop'), { status: 404 });
    return { shop: s.id, name: s.name, currency: s.currency, paypalMode: paypal.mode, paypalClientId: paypal.clientId ?? null, shopAgent: hasClaude ? 'claude' : 'rules', demoBuyer };
  }));

  const TOOLS = {
    search_products: (shop, a, agent) => svc.searchProducts(shop, { query: a.query, maxPrice: a.max_price, agent }),
    get_product: (shop, a) => svc.getProduct(shop, String(a.sku ?? '')),
    request_offer: (shop, a, agent) => svc.requestOffer(shop, {
      items: Array.isArray(a.items) ? a.items.slice(0, 20).map((i) => ({ sku: String(i.sku ?? ''), qty: i.qty })) : undefined,
      bid: a.bid,
      message: typeof a.message === 'string' ? a.message : undefined,
      negotiationId: typeof a.negotiation_id === 'string' ? a.negotiation_id : undefined,
      agent,
    }),
    accept_offer: (shop, a) => svc.acceptOffer(String(a.offer_id ?? '')),
    check_order: (shop, a) => svc.checkOrder(String(a.order_id ?? '')),
  };

  app.post('/api/shops/:shop/tools/:tool', wrap(async (req) => {
    const fn = TOOLS[req.params.tool];
    if (!fn) throw Object.assign(new Error('unknown_tool'), { status: 404 });
    const agent = String(req.get('X-Haggle-Agent') ?? '').slice(0, 60) || 'unknown agent';
    return fn(req.params.shop, req.body ?? {}, agent);
  }));

  // Demo buyer agent: the page sends the goal and the steps so far, and runs the next
  // tool itself through window.haggle.call, so the person sees every step. It never pays.
  app.post('/api/shops/:shop/demo-buyer/step', wrap(async (req) => {
    if (!demoBuyer) throw Object.assign(new Error('demo_buyer_off'), { status: 404 });
    const s = shops[req.params.shop];
    if (!s) throw Object.assign(new Error('unknown_shop'), { status: 404 });
    const goal = typeof req.body?.goal === 'string' ? req.body.goal : '';
    if (!goal.trim()) throw Object.assign(new Error('goal_required'), { status: 400 });
    return buyerAgent({ shopName: s.name, goal, steps: cleanSteps(req.body?.steps) });
  }));

  // Merchant view. Set MERCHANT_KEY to require ?key=... (the demo leaves it open).
  const merchantGate = (req, res, next) => {
    if (env.MERCHANT_KEY && req.query.key !== env.MERCHANT_KEY && req.get('X-Merchant-Key') !== env.MERCHANT_KEY) {
      return res.status(401).json({ error: 'merchant key required' });
    }
    next();
  };
  app.get('/api/merchant/:shop', merchantGate, wrap(async (req) => svc.merchantView(req.params.shop)));
  app.post('/api/merchant/:shop/floor', merchantGate, wrap(async (req) => svc.setFloor(req.params.shop, req.body?.sku, req.body?.floor)));

  // PayPal sends the buyer back here after approval; capture happens server-side.
  app.get('/checkout/return', async (req, res) => {
    const orderId = String(req.query.token ?? '');
    let status = 'unknown';
    try { status = (await svc.checkOrder(orderId)).status; } catch { status = 'not_found'; }
    res.type('html').send(resultPage(status === 'paid' ? 'Paid. Thank you!' : `Order status: ${status}`, status === 'paid'));
  });
  app.get('/checkout/cancel', (req, res) => res.type('html').send(resultPage('Payment cancelled. Nothing was charged.', false)));

  // Pages the script tag uses to finish checkout in place (PayPal buttons for the agreed order).
  app.post('/api/shops/:shop/orders/:id/capture', wrap(async (req) => svc.checkOrder(req.params.id)));

  if (paypal.mode === 'mock') {
    app.get('/mock-paypal/:id', (req, res) => {
      const o = paypal.peek(req.params.id);
      if (!o) return res.status(404).send('Unknown order');
      res.type('html').send(mockPage(o));
    });
    app.post('/mock-paypal/:id/approve', (req, res) => {
      paypal.approve(req.params.id);
      res.redirect(303, `/checkout/return?token=${encodeURIComponent(req.params.id)}`);
    });
  }

  // Demo shop. Origin trial tokens (one per origin) are injected when set.
  app.get(['/', '/shop', '/shop/'], async (req, res) => {
    let html = await readFile(path.join(PUBLIC, 'shop', 'index.html'), 'utf8');
    const tokens = [env.WEBMCP_OT_TOKEN, env.WEBMCP_OT_TOKEN_THIRD_PARTY].filter(Boolean);
    const metas = tokens.map((t) => `<meta http-equiv="origin-trial" content="${t.replace(/"/g, '')}">`).join('\n  ');
    html = html.replace('<!--ORIGIN_TRIAL-->', metas);
    res.type('html').send(html);
  });
  app.get('/haggle.js', async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'public, max-age=60');
    res.type('application/javascript').send(await readFile(path.join(PUBLIC, 'haggle.js'), 'utf8'));
  });
  app.get('/vendor/ag-grid.js', (req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(path.join(here, '..', 'node_modules', 'ag-grid-community', 'dist', 'ag-grid-community.min.noStyle.js'));
  });
  app.use(express.static(PUBLIC, { extensions: ['html'] }));
  app.get('/healthz', (req, res) => res.json({ ok: true, paypal: paypal.mode }));

  return { app, svc, paypal };
}

function buyerUsesClaude(env) {
  return env.DEMO_BUYER_AI !== 'off';
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function resultPage(text, ok) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Checkout</title><body style="font:16px system-ui;display:grid;place-items:center;min-height:90vh;background:#faf6f0;color:#2a2118">
<div style="text-align:center"><div style="font-size:48px">${ok ? '✓' : '·'}</div><h1 style="font-weight:600">${esc(text)}</h1>
<p>You can close this window and go back to the shop.</p></div>
<script>try{window.opener&&window.opener.postMessage({haggle:'checkout-done'},'*')}catch(e){}</script></body>`;
}

function mockPage(o) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mock PayPal approval</title><body style="font:16px system-ui;max-width:420px;margin:10vh auto;padding:0 16px">
<p style="background:#fff3cd;padding:8px 12px;border-radius:6px">Mock mode: this stands in for PayPal's sandbox approval page. No money moves.</p>
<h1>Approve ${esc(o.total.toFixed(2))} USD?</h1><p>Order ${esc(o.id)}</p>
<form method="post" action="/mock-paypal/${encodeURIComponent(o.id)}/approve"><button style="font-size:18px;padding:12px 24px;background:#ffc439;border:0;border-radius:24px">Pay now</button></form></body>`;
}

// Vercel runs the app as a function: it imports this file and calls the default export.
// The app is made on the first request, so importing this file in tests stays cheap.
let vercelApp;
export default function handler(req, res) {
  vercelApp ??= createApp().app;
  return vercelApp(req, res);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  const { app, paypal } = createApp();
  app.listen(port, () => console.log(`haggle on :${port} (PayPal ${paypal.mode})`));
}
