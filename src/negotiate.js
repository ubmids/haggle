// The deal-maker's rules. Pure functions, no I/O, so every guarantee here is testable.
//
// The one promise this file keeps: no offer it produces is ever below the
// merchant's floor. The AI (src/shopAgent.js) may pick a price and write the
// words, but every number it proposes passes through clampOffer() first.

export const DEFAULT_POLICY = Object.freeze({
  maxRounds: 3,            // counters before the shop gives its final word
  bundleQty: 2,            // items in a cart that unlock the full discount band
  singleItemBand: 0.5,     // single items can only fall halfway from list to floor
  acceptWithinPct: 3,      // a bid this close to the last counter is just accepted
  offerTtlSec: 15 * 60,    // how long an offer can be accepted
});

const toCents = (n) => Math.round(Number(n) * 100);
const fromCents = (c) => Math.round(c) / 100;

/**
 * Price a cart against the catalog. Returns null-free lines or an error string.
 * catalog: [{ sku, name, price, floor, stock, currency }]
 * items:   [{ sku, qty }]
 */
export function priceCart(catalog, items, policy = DEFAULT_POLICY) {
  if (!Array.isArray(items) || items.length === 0) return { error: 'empty_cart' };
  const bySku = new Map(catalog.map((p) => [p.sku, p]));
  const merged = new Map();
  for (const it of items) {
    const qty = Math.floor(Number(it.qty ?? 1));
    if (!it.sku || !Number.isFinite(qty) || qty < 1) return { error: 'bad_item', sku: it.sku ?? null };
    merged.set(it.sku, (merged.get(it.sku) ?? 0) + qty);
  }
  const lines = [];
  for (const [sku, qty] of merged) {
    const p = bySku.get(sku);
    if (!p) return { error: 'unknown_sku', sku };
    if (p.stock < qty) return { error: 'out_of_stock', sku, available: p.stock };
    lines.push({ sku, name: p.name, qty, unitList: p.price, unitFloor: p.floor });
  }
  const qtyTotal = lines.reduce((s, l) => s + l.qty, 0);
  const listC = lines.reduce((s, l) => s + toCents(l.unitList) * l.qty, 0);
  const floorC = lines.reduce((s, l) => s + toCents(l.unitFloor) * l.qty, 0);
  const isBundle = qtyTotal >= policy.bundleQty;
  // Lowest total the shop will go to for this cart. Bundles reach the floor;
  // single items stop part of the way, so buying more is always the better deal.
  const reachableC = isBundle ? floorC : Math.ceil(listC - (listC - floorC) * policy.singleItemBand);
  return {
    lines,
    qtyTotal,
    isBundle,
    currency: catalog[0]?.currency ?? 'USD',
    listTotal: fromCents(listC),
    floorTotal: fromCents(floorC),
    reachableTotal: fromCents(reachableC),
  };
}

/** Never below what this cart can reach, never above list. */
export function clampOffer(total, cart) {
  const c = toCents(total);
  const lo = toCents(cart.reachableTotal);
  const hi = toCents(cart.listTotal);
  return fromCents(Math.min(hi, Math.max(lo, Number.isFinite(c) ? c : hi)));
}

/**
 * One round of negotiation.
 * state: { round, lastCounter } from earlier rounds (round starts at 0)
 * bid:   the buyer agent's proposed total, or undefined for "what's your price?"
 * Returns { status, total, round, reason } where status is one of
 *   accepted  – the shop takes the bid (or list price, if the bid is above it)
 *   counter   – a new price the buyer can accept
 *   final     – the shop's last price; further bids below it are declined
 *   declined  – no deal this time (bid stays below what the cart can reach)
 */
export function decide(cart, state, bid, policy = DEFAULT_POLICY) {
  const round = (state?.round ?? 0) + 1;
  const last = state?.lastCounter ?? cart.listTotal;
  const wasFinal = state?.final === true;

  if (bid === undefined || bid === null || bid === '') {
    return { status: 'counter', total: last, round: round - 1, reason: 'quote' };
  }
  const b = Number(bid);
  if (!Number.isFinite(b) || b <= 0) return { status: 'declined', total: last, round, reason: 'bad_bid' };

  if (b >= cart.listTotal) return { status: 'accepted', total: cart.listTotal, round, reason: 'at_or_above_list' };
  if (b >= last) return { status: 'accepted', total: fromCents(toCents(b)), round, reason: 'meets_last_counter' };

  const reachable = cart.reachableTotal;
  if (wasFinal) {
    return b >= reachable
      ? { status: 'accepted', total: fromCents(toCents(b)), round, reason: 'meets_final' }
      : { status: 'declined', total: last, round, reason: 'below_final' };
  }

  if (b >= reachable) {
    const closeEnough = toCents(last - b) <= toCents(last) * (policy.acceptWithinPct / 100);
    if (closeEnough || round >= 2) {
      return { status: 'accepted', total: fromCents(toCents(b)), round, reason: closeEnough ? 'close_enough' : 'fair_bid' };
    }
    // First round: meet halfway, so the buyer's agent sees the shop move.
    const mid = clampOffer(fromCents(Math.ceil((toCents(last) + toCents(b)) / 2)), cart);
    return { status: 'counter', total: mid, round, reason: 'meet_halfway' };
  }

  // Bid is below what this cart can reach.
  if (round >= policy.maxRounds) {
    return { status: 'final', total: reachable, round, reason: cart.isBundle ? 'at_floor' : 'single_item_limit' };
  }
  const step = clampOffer(fromCents(Math.ceil((toCents(last) + toCents(reachable)) / 2)), cart);
  return { status: 'counter', total: step, round, reason: cart.isBundle ? 'moving_toward_floor' : 'bundle_would_unlock_more' };
}

/** Spread an agreed total across lines, so PayPal's item breakdown adds up exactly. */
export function allocate(cart, total) {
  const listC = toCents(cart.listTotal);
  const totalC = toCents(total);
  const discountC = listC - totalC;
  return {
    itemTotal: fromCents(listC),
    discount: fromCents(Math.max(0, discountC)),
    total: fromCents(totalC),
    lines: cart.lines.map((l) => ({ sku: l.sku, name: l.name, qty: l.qty, unitPrice: l.unitList })),
  };
}
