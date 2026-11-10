// Demo only, not part of the one line. For browsers with no WebMCP agent yet, this
// runs a buyer agent on the haggle server step by step and calls the shop's tools
// through window.haggle.call, so the activity feed and PayPal sheet show exactly
// what a real agent would cause. The agent never pays: you approve in PayPal.
(() => {
  'use strict';
  const AGENT = 'Demo buyer agent';
  const box = document.getElementById('demo-buyer');
  if (!box || !window.haggle) return;
  const form = box.querySelector('form');
  const input = box.querySelector('input');
  const button = box.querySelector('button');
  const log = box.querySelector('ol');
  if (window.haggle.webmcp) box.querySelector('.db-lead').textContent = 'Your browser has a WebMCP agent. You can also watch the demo agent:';

  const say = (text, kind = '') => {
    const li = document.createElement('li');
    li.textContent = text;
    if (kind) li.className = kind;
    log.appendChild(li);
    log.hidden = false;
  };

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

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const goal = input.value.trim();
    if (!goal) return;
    button.disabled = true;
    log.replaceChildren();
    const steps = [];
    try {
      for (let i = 0; i < 12; i++) {
        const step = await next(goal, steps);
        say(step.say || step.action, step.action === 'done' ? 'db-done' : '');
        if (step.action === 'done') break;
        const result = await window.haggle.call(step.action, step.args, { agent: AGENT });
        steps.push({ tool: step.action, args: step.args, result });
        await new Promise((r) => setTimeout(r, 600)); // slow enough to follow
      }
    } catch (err) {
      say(`Stopped: ${err.message}`, 'db-error');
    } finally {
      button.disabled = false;
    }
  });
})();
