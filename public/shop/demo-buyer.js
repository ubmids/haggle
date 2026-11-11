// Demo only, not part of the one line. For browsers with no WebMCP agent yet, this
// runs a buyer agent on the haggle server step by step and calls the shop's tools
// through window.haggle.call, so the haggling and the PayPal sheet are exactly
// what a real agent would cause. The agent never pays: you approve in PayPal.
(() => {
  'use strict';
  const AGENT = 'Demo buyer agent';
  const box = document.getElementById('demo-buyer');
  if (!box || !window.haggle) return;
  const form = box.querySelector('form');
  const input = box.querySelector('input');
  const button = box.querySelector('.goal-row button');
  const log = box.querySelector('#db-log');
  const deal = box.querySelector('#db-deal');
  const $ = (id) => box.querySelector(id);
  if (window.haggle.webmcp) $('#db-lead').textContent = 'Your browser has a WebMCP agent, so you can ask it to shop here. Or watch this one.';

  const money = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function message(side, text, { who, tool, kind, ai } = {}) {
    const li = el('li', `msg ${side}${kind ? ` ${kind}` : ''}`);
    const label = el('span', 'who', who ?? (side === 'buyer' ? 'Buyer agent' : "Shop's agent"));
    if (ai) label.append(el('span', 'ai', 'Claude'));
    li.append(label, el('div', 'bubble', text));
    if (tool) li.append(tool);
    log.append(li);
    follow();
    return li;
  }

  // Keep the newest line in view inside the console, without scrolling the page.
  function follow() {
    if (box.scrollHeight > box.clientHeight) box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
  }

  function typing(side) {
    const li = el('li', `msg ${side} typing`);
    const b = el('div', 'bubble');
    b.append(el('i'), el('i'), el('i'));
    li.append(b);
    log.append(li);
    follow();
    return li;
  }

  const fmt = (v) => Array.isArray(v) ? `[${v.map(fmt).join(', ')}]`
    : v && typeof v === 'object' ? `{ ${Object.entries(v).map(([k, x]) => `${k}: ${fmt(x)}`).join(', ')} }`
    : JSON.stringify(v);

  function toolLine(name, args) {
    const shown = Object.fromEntries(Object.entries(args ?? {}).filter(([k]) => k !== 'message' && k !== 'negotiation_id'));
    const line = el('div', 'tool');
    const b = el('b', '', name);
    line.append(b, document.createTextNode(`(${fmt(shown)})`));
    return line;
  }

  function showDeal(list, now, won = false) {
    deal.hidden = false;
    deal.classList.toggle('won', won);
    $('#db-list').textContent = money(list);
    $('#db-list').classList.toggle('struck', now < list);
    $('#db-now').textContent = money(now);
    $('#db-meter').style.width = `${Math.max(8, Math.min(100, (now / list) * 100))}%`;
  }

  function highlight(skus) {
    document.querySelectorAll('.card.agent-looking').forEach((c) => c.classList.remove('agent-looking'));
    for (const sku of skus) document.querySelector(`.card[data-sku="${CSS.escape(sku)}"]`)?.classList.add('agent-looking');
  }

  const VERB = { accepted: 'Accepted', counter: 'Counter-offer', final: 'Final offer', declined: 'Declined' };

  function shopReply(action, result) {
    if (action === 'search_products') {
      const n = result.results?.length ?? 0;
      highlight((result.results ?? []).slice(0, 1).map((p) => p.sku));
      if (result.match === 'exact' && n) return null;
      return message('shop', n ? `No exact match. Closest: ${result.results[0].name}.` : 'Nothing like that in this shop.', { who: 'Shop' });
    }
    if (action === 'request_offer') {
      showDeal(result.listTotal, result.total, result.status === 'accepted');
      const line = el('div', 'tool', `${VERB[result.status] ?? result.status}: ${money(result.total)}`);
      return message('shop', result.message || `${VERB[result.status]}: ${money(result.total)}`, { tool: line, ai: result.wordedBy === 'claude' });
    }
    if (action === 'accept_offer') {
      showDeal(result.listTotal, result.total, true);
      return null;
    }
    return null;
  }

  async function next(goal, steps) {
    const res = await fetch(`/api/shops/${encodeURIComponent(window.haggle.shop)}/demo-buyer/step`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal, steps }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json;
  }

  box.querySelector('.chips').addEventListener('click', (e) => {
    const g = e.target.closest('button')?.dataset.goal;
    if (!g || button.disabled) return;
    input.value = g;
    form.requestSubmit();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const goal = input.value.trim();
    if (!goal) return;
    button.disabled = true;
    box.classList.add('running');
    log.replaceChildren();
    deal.hidden = true;
    highlight([]);
    message('buyer', goal, { who: 'You' }).classList.add('you');
    const steps = [];
    try {
      for (let i = 0; i < 12; i++) {
        const dots = typing('buyer');
        const [step] = await Promise.all([next(goal, steps), wait(500)]);
        dots.remove();
        const ai = step.by === 'claude';
        if (step.action === 'done') { message('buyer', step.say || 'Done.', { kind: 'done', ai }); break; }
        message('buyer', step.say || step.action, { tool: toolLine(step.action, step.args), ai });
        const shopDots = step.action === 'request_offer' ? typing('shop') : null;
        const [result] = await Promise.all([window.haggle.call(step.action, step.args, { agent: AGENT }), wait(shopDots ? 700 : 250)]);
        shopDots?.remove();
        shopReply(step.action, result);
        steps.push({ tool: step.action, args: step.args, result });
        await wait(450);
      }
    } catch (err) {
      message('buyer', `Stopped: ${err.message}`, { kind: 'error' });
    } finally {
      button.disabled = false;
    }
  });
})();
