// What the WebMCP tools call. Every price is decided here, on the server,
// from the merchant's catalog. Nothing an agent sends can set a price directly.

import { randomUUID } from 'node:crypto';
import { priceCart, decide, allocate, DEFAULT_POLICY } from './negotiate.js';
import { publicProduct } from './shops.js';

const STOP = new Set(['a', 'an', 'the', 'some', 'for', 'of', 'and', 'with', 'under', 'below', 'to', 'me', 'i', 'want', 'buy', 'get', 'two', 'one']);

function terms(q) {
  return String(q ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((t) => t.replace(/s$/, ''))
    .filter((t) => t && !STOP.has(t));
}

export function createService({ shops, paypal, shopAgent, now = () => Date.now(), publicUrl = '' }) {
  const negotiations = new Map(); // id -> { shopId, items, round, lastCounter, final, history, agent, startedAt }
  const offers = new Map();       // id -> offer
  const orders = new Map();       // paypal order id -> order record
  const events = [];              // demand and negotiation events for the merchant view

  const shopOf = (shopId) => {
    const s = shops[shopId];
    if (!s) throw Object.assign(new Error('unknown_shop'), { status: 404 });
    return s;
  };
  const policyOf = (s) => ({ ...DEFAULT_POLICY, ...(s.policy ?? {}) });
  const log = (e) => { events.push({ at: new Date(now()).toISOString(), ...e }); if (events.length > 5000) events.shift(); };

  function searchProducts(shopId, { query, maxPrice, agent } = {}) {
    const s = shopOf(shopId);
    const t = terms(query);
    let hits = s.catalog.filter((p) => {
      const hay = terms(`${p.name} ${p.color} ${p.kind} ${p.description}`).join(' ');
      return t.length === 0 || t.every((w) => hay.includes(w));
    });
    // Fall back to any-term matches so "green cup" still finds a green mug.
    if (hits.length === 0 && t.length > 1) {
      hits = s.catalog.filter((p) => t.some((w) => terms(`${p.name} ${p.color} ${p.kind}`).includes(w)));
    }
    if (maxPrice !== undefined && maxPrice !== null && maxPrice !== '') {
      hits = hits.filter((p) => p.price <= Number(maxPrice) * 1.0001);
    }
    const results = hits.map((p) => publicProduct(p, s.currency));
    log({ type: results.length ? 'search' : 'search_miss', shopId, query: String(query ?? ''), maxPrice: maxPrice ?? null, results: results.length, agent: agent ?? null });
    return {
      results,
      note: results.length
        ? 'Prices are list prices. Use request_offer to ask the shop for a deal before checkout.'
        : 'Nothing matched. The shop has been told what you looked for.',
    };
  }

  function getProduct(shopId, sku) {
    const s = shopOf(shopId);
    const p = s.catalog.find((x) => x.sku === sku);
    if (!p) throw Object.assign(new Error('unknown_sku'), { status: 404 });
    return publicProduct(p, s.currency);
  }

  async function requestOffer(shopId, { items, bid, message, negotiationId, agent } = {}) {
    const s = shopOf(shopId);
    const policy = policyOf(s);
    let neg = negotiationId ? negotiations.get(negotiationId) : null;
    if (neg && neg.shopId !== shopId) neg = null;
    const sameCart = neg && JSON.stringify(neg.items) === JSON.stringify(items ?? neg.items);
    if (!neg || !sameCart) {
      neg = { id: randomUUID(), shopId, items: items ?? [], round: 0, lastCounter: null, final: false, history: [], agent: agent ?? null, startedAt: new Date(now()).toISOString() };
      negotiations.set(neg.id, neg);
    }
    const cart = priceCart(s.catalog, neg.items, policy);
    if (cart.error) {
      log({ type: 'cart_error', shopId, error: cart.error, sku: cart.sku ?? null, agent: agent ?? null });
      return { status: 'unavailable', error: cart.error, sku: cart.sku ?? null, available: cart.available ?? null };
    }

    const state = { round: neg.round, lastCounter: neg.lastCounter ?? cart.listTotal, final: neg.final };
    let d = decide(cart, state, bid, policy);
    const r = await shopAgent({ shopName: s.name, voice: s.voice, cart, decision: d, buyerMessage: message, history: neg.history });
    let total = r.total;
    // If the shop agent's counter lands at or below the bid, just take the bid.
    if ((d.status === 'counter' || d.status === 'final') && bid !== undefined && Number(bid) >= cart.reachableTotal && total <= Number(bid)) {
      d = { ...d, status: 'accepted', reason: 'agent_met_bid' };
      total = Math.round(Number(bid) * 100) / 100;
    }
    neg.round = d.round;
    if (d.status !== 'declined') neg.lastCounter = total;
    neg.final = neg.final || d.status === 'final';
    neg.history.push({ round: d.round, bid: bid ?? null, buyerMessage: message ?? null, status: d.status, total, shopMessage: r.message, by: r.by });

    const offer = {
      id: 'OFF-' + randomUUID().slice(0, 8).toUpperCase(),
      negotiationId: neg.id,
      shopId,
      shopName: s.name,
      currency: cart.currency,
      items: cart.lines.map((l) => ({ sku: l.sku, name: l.name, qty: l.qty })),
      listTotal: cart.listTotal,
      total,
      allocation: allocate(cart, total),
      status: d.status,
      round: d.round,
      agent: neg.agent,
      expiresAt: new Date(now() + policy.offerTtlSec * 1000).toISOString(),
      returnUrl: `${publicUrl}/checkout/return`,
      cancelUrl: `${publicUrl}/checkout/cancel`,
    };
    const acceptable = d.status !== 'declined';
    if (acceptable) offers.set(offer.id, offer);
    log({ type: d.status === 'declined' ? 'offer_declined' : 'offer', shopId, status: d.status, round: d.round, bid: bid ?? null, total, listTotal: cart.listTotal, negotiationId: neg.id, agent: neg.agent, by: r.by });

    return {
      negotiationId: neg.id,
      status: d.status,
      offerId: acceptable ? offer.id : null,
      total,
      listTotal: cart.listTotal,
      savings: Math.round((cart.listTotal - total) * 100) / 100,
      currency: cart.currency,
      message: r.message,
      round: d.round,
      expiresAt: acceptable ? offer.expiresAt : null,
      next: acceptable
        ? 'Call accept_offer with offerId to start PayPal checkout, or request_offer again with the same negotiationId and a new bid.'
        : 'Make a higher bid with the same negotiationId.',
    };
  }

  async function acceptOffer(offerId) {
    const offer = offers.get(offerId);
    if (!offer) throw Object.assign(new Error('unknown_offer'), { status: 404 });
    if (offer.orderId) return pendingOrder(orders.get(offer.orderId));
    if (Date.parse(offer.expiresAt) < now()) throw Object.assign(new Error('offer_expired'), { status: 410 });
    // Re-check stock at checkout time.
    const s = shopOf(offer.shopId);
    const cart = priceCart(s.catalog, offer.items, policyOf(s));
    if (cart.error) throw Object.assign(new Error(cart.error), { status: 409 });
    const pp = await paypal.createOrder(offer);
    const rec = {
      orderId: pp.id, offerId, shopId: offer.shopId, negotiationId: offer.negotiationId, status: pp.status,
      approveUrl: pp.approveUrl, total: offer.total, listTotal: offer.listTotal, currency: offer.currency,
      items: offer.items, rounds: offer.round, agent: offer.agent, placedBy: 'agent',
      createdAt: new Date(now()).toISOString(), mode: paypal.mode,
    };
    offer.orderId = pp.id;
    orders.set(pp.id, rec);
    log({ type: 'checkout_started', shopId: offer.shopId, orderId: pp.id, total: offer.total, agent: offer.agent });
    return pendingOrder(rec);
  }

  function pendingOrder(rec) {
    return {
      orderId: rec.orderId,
      status: 'awaiting_buyer_approval',
      total: rec.total,
      listTotal: rec.listTotal,
      savings: Math.round((rec.listTotal - rec.total) * 100) / 100,
      currency: rec.currency,
      approveUrl: rec.approveUrl,
      message: 'The buyer now approves this payment in PayPal. The agent cannot pay on their behalf. Call check_order after they approve.',
    };
  }

  async function checkOrder(orderId) {
    const rec = orders.get(orderId);
    if (!rec) throw Object.assign(new Error('unknown_order'), { status: 404 });
    if (rec.status !== 'COMPLETED') {
      const pp = await paypal.getOrder(orderId);
      rec.status = pp.status;
      if (pp.status === 'APPROVED') {
        const cap = await paypal.captureOrder(orderId);
        rec.status = cap.status;
        rec.captureId = cap.captureId;
        rec.paidAt = new Date(now()).toISOString();
        const s = shopOf(rec.shopId);
        for (const it of rec.items) {
          const p = s.catalog.find((x) => x.sku === it.sku);
          if (p) p.stock = Math.max(0, p.stock - it.qty);
        }
        log({ type: 'order_paid', shopId: rec.shopId, orderId, total: rec.total, agent: rec.agent });
      }
    }
    return {
      orderId,
      status: rec.status === 'COMPLETED' ? 'paid' : rec.status === 'CREATED' ? 'awaiting_buyer_approval' : rec.status.toLowerCase(),
      total: rec.total,
      currency: rec.currency,
      captureId: rec.captureId ?? null,
    };
  }

  function merchantView(shopId) {
    const s = shopOf(shopId);
    const mine = (x) => x.shopId === shopId;
    const missCounts = new Map();
    for (const e of events.filter((e) => mine(e) && (e.type === 'search_miss' || e.type === 'offer_declined'))) {
      const key = e.type === 'search_miss' ? `search: ${e.query}${e.maxPrice ? ` (under ${e.maxPrice})` : ''}` : `price: bid ${e.bid} vs ${e.total}`;
      missCounts.set(key, { what: key, kind: e.type, count: (missCounts.get(key)?.count ?? 0) + 1, last: e.at });
    }
    return {
      shop: { id: s.id, name: s.name, currency: s.currency, paypalMode: paypal.mode },
      products: s.catalog.map((p) => ({ ...p })),
      orders: [...orders.values()].filter(mine).reverse(),
      negotiations: [...negotiations.values()].filter(mine).map((n) => ({
        id: n.id, agent: n.agent, startedAt: n.startedAt, rounds: n.round,
        items: n.items.map((i) => `${i.qty}× ${i.sku}`).join(', '),
        lastTotal: n.lastCounter, final: n.final,
        history: n.history,
      })).reverse(),
      missedDemand: [...missCounts.values()].sort((a, b) => b.count - a.count),
    };
  }

  function setFloor(shopId, sku, floor) {
    const s = shopOf(shopId);
    const p = s.catalog.find((x) => x.sku === sku);
    if (!p) throw Object.assign(new Error('unknown_sku'), { status: 404 });
    const f = Number(floor);
    if (!Number.isFinite(f) || f <= 0 || f > p.price) throw Object.assign(new Error('floor must be above 0 and at most the list price'), { status: 400 });
    p.floor = Math.round(f * 100) / 100;
    return { sku, floor: p.floor };
  }

  return { searchProducts, getProduct, requestOffer, acceptOffer, checkOrder, merchantView, setFloor, _state: { offers, orders, negotiations, events } };
}
