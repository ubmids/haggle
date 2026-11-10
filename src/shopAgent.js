// The shop's own agent. Claude reads the buyer agent's message and picks a price
// inside the band the rules engine allows, then writes the reply. The engine's
// decision always comes first and the final number is clamped, so the model can
// make the shop friendlier but never cheaper than the merchant allowed.

import { clampOffer } from './negotiate.js';

const SCHEMA = {
  type: 'object',
  properties: {
    total: { type: 'number', description: 'The total price to offer, in the cart currency.' },
    message: { type: 'string', description: 'One or two friendly sentences to the buyer agent, in the shop voice.' },
  },
  required: ['total', 'message'],
  additionalProperties: false,
};

export function templateMessage(shopName, d, cart) {
  const amt = (n) => `${cart.currency === 'USD' ? '$' : cart.currency + ' '}${n.toFixed(2)}`;
  switch (d.status) {
    case 'accepted':
      return `Deal. ${shopName} will do ${amt(d.total)} for this cart. Accept the offer to pay with PayPal.`;
    case 'counter':
      if (d.reason === 'quote') return `The price for this cart is ${amt(d.total)}. You can make an offer.`;
      if (d.reason === 'bundle_would_unlock_more')
        return `I can do ${amt(d.total)} on a single item. Add one more and I can go lower.`;
      return `I can meet you at ${amt(d.total)}.`;
    case 'final':
      return `${amt(d.total)} is my best price for this cart. It's yours if you want it.`;
    case 'declined':
      return `I can't go that low. ${amt(d.total)} is still on the table.`;
    default:
      return `${amt(d.total)}.`;
  }
}

/**
 * Turn the engine's decision into the shop's reply.
 * Without ANTHROPIC_API_KEY (or on any error) it falls back to templates.
 */
export function createShopAgent({ client, model = process.env.HAGGLE_MODEL || 'claude-opus-5-5', timeoutMs = 8000 } = {}) {
  return async function reply({ shopName, voice, cart, decision, buyerMessage, history }) {
    const base = { total: decision.total, message: templateMessage(shopName, decision, cart), by: 'rules' };
    // Accepted and declined outcomes are settled by the rules; the model only words counters.
    if (!client || decision.status === 'accepted' || decision.status === 'declined' || decision.reason === 'quote') {
      return base;
    }
    const lo = cart.reachableTotal;
    const hi = decision.status === 'final' ? decision.total : Math.max(decision.total, lo);
    const system = [
      `You are the sales agent for ${shopName}, a small online shop. ${voice ?? ''}`.trim(),
      'Another AI agent is buying on behalf of a person. Be warm, brief and honest.',
      'Never mention floors, rules, bands or that you are constrained. Never invent stock, shipping or products.',
      `Offer a total between ${lo.toFixed(2)} and ${hi.toFixed(2)} ${cart.currency}. Prefer ${decision.total.toFixed(2)} unless the buyer gives a good reason.`,
      cart.isBundle ? '' : 'If it fits, mention that adding another item gets a better price.',
    ].filter(Boolean).join('\n');
    const user = JSON.stringify({
      cart: cart.lines.map((l) => ({ name: l.name, qty: l.qty, unit_price: l.unitList })),
      list_total: cart.listTotal,
      buyer_message: (buyerMessage ?? '').slice(0, 500),
      earlier_rounds: (history ?? []).slice(-4),
      is_final_round: decision.status === 'final',
    });
    try {
      const ctrl = AbortSignal.timeout(timeoutMs);
      const res = await client.beta.messages.create(
        {
          model,
          max_tokens: 1024,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system,
          messages: [{ role: 'user', content: user }],
          output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
        },
        { signal: ctrl },
      );
      if (res.stop_reason === 'refusal') return base;
      const text = res.content.find((b) => b.type === 'text')?.text;
      const parsed = JSON.parse(text);
      let total = clampOffer(parsed.total, cart);
      if (total > hi) total = hi;
      const message = String(parsed.message ?? '').slice(0, 400) || base.message;
      return { total, message, by: 'claude' };
    } catch {
      return base;
    }
  };
}
