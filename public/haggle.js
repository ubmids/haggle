/*!
 * haggle.js: one line makes your shop buyable, and haggle-able, by AI agents.
 *
 *   <script src="https://YOUR-HAGGLE-HOST/haggle.js" data-shop="your-shop-id" defer></script>
 *
 * It registers WebMCP tools (document.modelContext) so a browser's AI agent can
 * search your products, ask for a deal, and start PayPal checkout. Prices and
 * floors live on the haggle server, never in this file. The agent can never pay:
 * a person approves every payment in PayPal.
 *
 * MIT licence. No dependencies.
 */
(() => {
  'use strict';

  const script = document.currentScript;
  const API = new URL(script?.src ?? '/haggle.js', location.href).origin;
  const SHOP = script?.dataset.shop ?? 'ikoko';
  const AGENT_LABEL = script?.dataset.agentLabel; // optional: lets a demo name its agent
  const FEED_CLOSED = script?.dataset.feed === 'closed'; // optional: keep the activity feed shut until clicked
  const modelContext = document.modelContext ?? navigator.modelContext ?? null;

  // ---- Talking to the haggle server ---------------------------------------

  async function callServer(tool, args, agent) {
    const res = await fetch(`${API}/api/shops/${encodeURIComponent(SHOP)}/tools/${tool}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Haggle-Agent': agent ?? AGENT_LABEL ?? agentName() },
      body: JSON.stringify(args ?? {}),
    });
    const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json;
  }

  function agentName() {
    const ua = navigator.userAgent;
    if (/ChatGPT/i.test(ua)) return 'ChatGPT';
    if (/Edg\//.test(ua)) return 'Edge agent';
    if (/Chrome\//.test(ua)) return 'Chrome agent';
    return 'browser agent';
  }

  // ---- The tools -------------------------------------------------------------

  const cartItems = {
    type: 'array',
    description: 'Products and quantities, e.g. [{"sku":"mug-green","qty":2}].',
    items: {
      type: 'object',
      properties: { sku: { type: 'string' }, qty: { type: 'integer', minimum: 1 } },
      required: ['sku', 'qty'],
    },
    minItems: 1,
  };

  const TOOLS = [
    {
      name: 'search_products',
      description: 'Search this shop\'s products. Returns list prices, stock and SKUs. Prices are negotiable: use request_offer before checkout.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What the shopper wants, e.g. "green mug".' },
          max_price: { type: 'number', description: 'Optional highest list price per item.' },
        },
      },
      annotations: { readOnlyHint: true },
      feed: (a, r) => `searched “${a.query ?? ''}”: ${r.match === 'exact' ? `${r.results.length} found` : r.results.length ? 'no exact match' : 'nothing found'}`,
    },
    {
      name: 'get_product',
      description: 'Get one product by SKU.',
      inputSchema: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] },
      annotations: { readOnlyHint: true },
      feed: (a, r) => `looked at ${r.name}`,
    },
    {
      name: 'request_offer',
      description:
        'Ask the shop for a price on a cart. Leave out bid to get the current price, or bid a total you would pay. ' +
        'The shop\'s own agent answers with accepted, counter, final or declined, and an offerId you can accept. ' +
        'Pass negotiation_id from the last answer to keep negotiating the same cart. Buying more items unlocks better prices.',
      inputSchema: {
        type: 'object',
        properties: {
          items: cartItems,
          bid: { type: 'number', description: 'Total you propose to pay for the whole cart, in the shop currency.' },
          message: { type: 'string', description: 'Optional note to the shop, e.g. why you are asking.' },
          negotiation_id: { type: 'string', description: 'From a previous request_offer answer, to continue that negotiation.' },
        },
        required: ['items'],
      },
      feed: (a, r) => {
        const bid = a.bid !== undefined ? `bid ${money(a.bid, r.currency)}, ` : '';
        const verb = { accepted: 'shop accepted', counter: 'shop countered', final: 'shop’s final offer', declined: 'shop declined' }[r.status] ?? r.status;
        return `${bid}${verb} at ${money(r.total, r.currency)}`;
      },
    },
    {
      name: 'accept_offer',
      description:
        'Accept an offer and start PayPal checkout for its agreed total. A person must approve the payment in PayPal; ' +
        'this tool shows them the PayPal button on the page. Then call check_order.',
      inputSchema: { type: 'object', properties: { offer_id: { type: 'string' } }, required: ['offer_id'] },
      feed: (a, r) => `accepted the deal, waiting for you to approve ${money(r.total, r.currency)} in PayPal`,
      after: (a, r) => showCheckout(r),
    },
    {
      name: 'check_order',
      description: 'Check whether the buyer approved and paid. Returns awaiting_buyer_approval or paid.',
      inputSchema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] },
      annotations: { readOnlyHint: true },
      feed: (a, r) => (r.status === 'paid' ? `order paid: ${money(r.total, r.currency)}` : `order ${r.status.replace(/_/g, ' ')}`),
    },
  ];

  async function run(tool, args, opts) {
    feed(`${tool.name.replace(/_/g, ' ')}…`, 'pending');
    try {
      const result = await callServer(tool.name, args, opts?.agent);
      feed(tool.feed(args ?? {}, result), 'done');
      tool.after?.(args ?? {}, result);
      return result;
    } catch (err) {
      feed(`${tool.name.replace(/_/g, ' ')} failed: ${err.message}`, 'error');
      throw err;
    }
  }

  // WebMCP: register each tool. Results go back as text the agent can read.
  const controller = new AbortController();
  let registered = false;
  if (modelContext?.registerTool) {
    for (const tool of TOOLS) {
      try {
        modelContext.registerTool(
          {
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: tool.annotations,
            execute: async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await run(tool, args)) }] }),
          },
          { signal: controller.signal },
        );
        registered = true;
      } catch (err) {
        console.warn('[haggle] could not register', tool.name, err);
      }
    }
  }

  // Same tools for agents that don't speak WebMCP yet, and for tests.
  window.haggle = {
    shop: SHOP,
    webmcp: registered,
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    // opts.agent names the caller in the merchant view, e.g. a demo agent.
    call: (name, args, opts) => {
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return Promise.reject(new Error(`unknown tool ${name}`));
      return run(tool, args, opts);
    },
    unregister: () => controller.abort(),
  };

  // ---- What the shopper sees ---------------------------------------------------

  const css = `
  .hg-badge{position:fixed;right:16px;bottom:16px;z-index:2147483000;font:13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;color:#1d1a16;display:flex;flex-direction:column;align-items:flex-end}
  .hg-pill{display:flex;align-items:center;gap:8px;background:#fff;border:1px solid #e6e0d6;border-radius:999px;padding:7px 13px 7px 11px;box-shadow:0 4px 18px rgba(0,0,0,.08);cursor:pointer;font-weight:500}
  .hg-pill small{font-weight:400;color:#7a6f61}
  .hg-dot{width:8px;height:8px;border-radius:50%;background:${registered ? '#1f9d55' : '#c08a1e'};box-shadow:0 0 0 3px ${registered ? 'rgba(31,157,85,.18)' : 'rgba(192,138,30,.18)'}}
  .hg-feed{margin-bottom:8px;background:#fff;border:1px solid #e6e0d6;border-radius:14px;box-shadow:0 8px 28px rgba(0,0,0,.10);width:min(320px,calc(100vw - 32px));max-height:40vh;overflow:auto;display:none}
  .hg-feed.open{display:block}
  .hg-feed h4{margin:0;padding:10px 14px;border-bottom:1px solid #f0ebe3;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#7a6f61}
  .hg-row{padding:8px 14px;border-bottom:1px solid #f6f2ec}
  .hg-row:last-child{border-bottom:0}
  .hg-row.pending{color:#7a6f61}.hg-row.error{color:#b42318}
  .hg-scrim{position:fixed;inset:0;z-index:2147483001;background:rgba(20,16,12,.35);display:flex;align-items:flex-end;justify-content:center;animation:hg-fade .2s ease-out}
  .hg-sheet{width:min(440px,100%);background:#fff;border-radius:20px 20px 0 0;box-shadow:0 -12px 40px rgba(0,0,0,.18);padding:22px 20px 26px;font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;color:#1d1a16;animation:hg-up .28s cubic-bezier(.2,.8,.2,1)}
  @media (min-width:600px){.hg-scrim{align-items:center}.hg-sheet{border-radius:20px}}
  @keyframes hg-up{from{transform:translateY(24px);opacity:0}}
  @keyframes hg-fade{from{opacity:0}}
  .hg-kicker{font-size:12px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#1f7a45}
  .hg-sheet h3{margin:4px 0 14px;font-size:20px;letter-spacing:-.01em}
  .hg-lines{margin:0 0 12px;padding:0;list-style:none;border-top:1px solid #efe9df}
  .hg-lines li{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #efe9df;font-size:14px}
  .hg-lines li span:last-child{font-variant-numeric:tabular-nums}
  .hg-total{display:flex;justify-content:space-between;align-items:baseline;font-weight:700;font-size:18px}
  .hg-was{text-decoration:line-through;color:#8a8073;font-weight:400;font-size:14px;margin-right:6px}
  .hg-save{display:inline-block;margin-top:6px;color:#1f7a45;background:#e3f3e9;font-weight:600;font-size:13px;padding:3px 9px;border-radius:999px}
  .hg-close{float:right;border:0;background:#f3eee7;width:30px;height:30px;border-radius:50%;font-size:18px;line-height:1;cursor:pointer;color:#5c5246}
  .hg-pp{margin-top:16px;min-height:48px}
  .hg-link{display:block;text-align:center;background:#ffc439;color:#111;border-radius:24px;padding:13px;font-weight:700;text-decoration:none}
  .hg-link:hover{filter:brightness(.97)}
  .hg-note{font-size:12px;color:#7a6f61;margin-top:12px;text-align:center}
  @media (prefers-color-scheme: dark){.hg-pill,.hg-feed,.hg-sheet{background:#1f1c19;color:#f2ede6;border-color:#3a342d}.hg-pill small,.hg-note{color:#a99d8e}.hg-row,.hg-feed h4,.hg-lines,.hg-lines li{border-color:#2c2823}.hg-close{background:#2c2823;color:#d8cfc4}.hg-save{background:#17301f;color:#5cc98b}.hg-kicker{color:#5cc98b}}
  `;

  let feedEl, pillLabel;
  function mountBadge() {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    const wrap = document.createElement('div');
    wrap.className = 'hg-badge';
    wrap.innerHTML = `<div class="hg-feed" role="log" aria-live="polite"><h4>Agent activity</h4></div>
      <div class="hg-pill" role="button" tabindex="0" title="${registered ? 'AI agents can shop and make offers here (WebMCP)' : 'WebMCP is not on in this browser'}">
        <span class="hg-dot"></span><span class="hg-label">Agent-ready</span><small>${registered ? 'WebMCP on' : 'WebMCP off here'}</small></div>`;
    document.body.appendChild(wrap);
    feedEl = wrap.querySelector('.hg-feed');
    pillLabel = wrap.querySelector('.hg-label');
    const toggle = () => feedEl.classList.toggle('open');
    wrap.querySelector('.hg-pill').addEventListener('click', toggle);
    wrap.querySelector('.hg-pill').addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && toggle());
  }

  let pendingRow = null;
  let idleTimer;
  function feed(text, kind) {
    if (!feedEl) return;
    if (!FEED_CLOSED) feedEl.classList.add('open');
    if (kind !== 'pending' && pendingRow) { pendingRow.remove(); pendingRow = null; }
    const row = document.createElement('div');
    row.className = `hg-row ${kind}`;
    row.textContent = text;
    feedEl.appendChild(row);
    feedEl.scrollTop = feedEl.scrollHeight;
    if (kind === 'pending') pendingRow = row;
    if (kind === 'done') {
      pillLabel.textContent = 'Agent shopping…';
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { if (pillLabel.textContent === 'Agent shopping…') pillLabel.textContent = 'Agent-ready'; }, 15000);
    }
  }

  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function money(n, currency = 'USD') {
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(n); } catch { return `${currency} ${Number(n).toFixed(2)}`; }
  }

  // The one human step: approve the agreed total in PayPal.
  let configPromise;
  const config = () => (configPromise ??= fetch(`${API}/api/shops/${encodeURIComponent(SHOP)}/config`).then((r) => r.json()));

  async function showCheckout(order) {
    document.querySelector('.hg-scrim')?.remove();
    const cfg = await config();
    const scrim = document.createElement('div');
    scrim.className = 'hg-scrim';
    const sheet = document.createElement('div');
    sheet.className = 'hg-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Approve payment');
    const lines = (order.items ?? []).map((i) => `<li><span>${i.qty}× ${esc(i.name ?? i.sku)}</span></li>`).join('');
    sheet.innerHTML = `<div class="hg-sheet-in">
      <button class="hg-close" aria-label="Close">×</button>
      <div class="hg-kicker">Your agent got you a deal</div>
      <h3>Approve ${money(order.total, order.currency)} in PayPal</h3>
      ${lines ? `<ul class="hg-lines">${lines}</ul>` : ''}
      <div class="hg-total"><span>Total</span><span>${order.savings > 0 ? `<span class="hg-was">${money(order.listTotal, order.currency)}</span>` : ''}${money(order.total, order.currency)}</span></div>
      ${order.savings > 0 ? `<span class="hg-save">You save ${money(order.savings, order.currency)}</span>` : ''}
      <div class="hg-pp"></div>
      <div class="hg-note">${cfg.paypalMode === 'sandbox' ? 'PayPal sandbox: test money only.' : 'Mock checkout: no PayPal account, no money moves.'} Your agent can't pay for you. Only you can approve this.</div>
    </div>`;
    scrim.appendChild(sheet);
    document.body.appendChild(scrim);
    const close = () => scrim.remove();
    sheet.querySelector('.hg-close').addEventListener('click', close);
    scrim.addEventListener('click', (e) => e.target === scrim && close());
    const pp = sheet.querySelector('.hg-pp');

    const done = async () => {
      const r = await window.haggle.call('check_order', { order_id: order.orderId }).catch(() => null);
      if (r?.status === 'paid') {
        pp.innerHTML = `<div class="hg-link" style="background:#1f9d55;color:#fff">Paid ✓</div>`;
        pillLabel.textContent = 'Order placed by your agent';
        setTimeout(close, 4000);
      }
    };

    if (cfg.paypalMode === 'sandbox' && cfg.paypalClientId) {
      try {
        await loadPayPal(cfg.paypalClientId, order.currency);
        window.paypal.Buttons({
          style: { layout: 'vertical', shape: 'pill', label: 'pay' },
          createOrder: () => order.orderId,
          onApprove: done,
          onError: (err) => feed(`PayPal error: ${err?.message ?? err}`, 'error'),
        }).render(pp);
        return;
      } catch (err) {
        console.warn('[haggle] PayPal buttons failed, using the approval link', err);
      }
    }
    // Approval link: PayPal's own page (sandbox) or the local mock page.
    pp.innerHTML = `<a class="hg-link" href="${order.approveUrl}" target="_blank" rel="noopener">Approve with PayPal</a>`;
    window.addEventListener('message', (e) => e.data?.haggle === 'checkout-done' && done(), { once: true });
    pp.querySelector('a').addEventListener('click', () => {
      const poll = setInterval(async () => {
        if (!document.body.contains(sheet)) return clearInterval(poll);
        const r = await callServer('check_order', { order_id: order.orderId }).catch(() => null);
        if (r?.status === 'paid') { clearInterval(poll); feed(`order paid: ${money(r.total, r.currency)}`, 'done'); done(); }
      }, 2500);
    });
  }

  function loadPayPal(clientId, currency) {
    if (window.paypal?.Buttons) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=${encodeURIComponent(currency)}&intent=capture`;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  if (document.body) mountBadge();
  else document.addEventListener('DOMContentLoaded', mountBadge, { once: true });
})();
