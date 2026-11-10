import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceCart, decide, clampOffer, allocate, DEFAULT_POLICY } from '../src/negotiate.js';

const catalog = [
  { sku: 'mug-green', name: 'Green mug', price: 18, floor: 12, stock: 10, currency: 'USD' },
  { sku: 'mug-blue', name: 'Blue mug', price: 18, floor: 13, stock: 1, currency: 'USD' },
  { sku: 'bowl', name: 'Bowl', price: 25.5, floor: 19.99, stock: 3, currency: 'USD' },
];

test('prices a bundle: list, floor and reachable totals', () => {
  const cart = priceCart(catalog, [{ sku: 'mug-green', qty: 2 }]);
  assert.equal(cart.listTotal, 36);
  assert.equal(cart.floorTotal, 24);
  assert.equal(cart.isBundle, true);
  assert.equal(cart.reachableTotal, 24);
});

test('single items only reach halfway to the floor', () => {
  const cart = priceCart(catalog, [{ sku: 'mug-green', qty: 1 }]);
  assert.equal(cart.isBundle, false);
  assert.equal(cart.reachableTotal, 15);
});

test('merges repeated skus and rejects bad carts', () => {
  assert.equal(priceCart(catalog, [{ sku: 'mug-green', qty: 1 }, { sku: 'mug-green', qty: 1 }]).qtyTotal, 2);
  assert.equal(priceCart(catalog, []).error, 'empty_cart');
  assert.equal(priceCart(catalog, [{ sku: 'nope', qty: 1 }]).error, 'unknown_sku');
  assert.equal(priceCart(catalog, [{ sku: 'mug-blue', qty: 2 }]).error, 'out_of_stock');
  assert.equal(priceCart(catalog, [{ sku: 'mug-green', qty: 0 }]).error, 'bad_item');
});

test('clampOffer keeps every price between reachable and list', () => {
  const cart = priceCart(catalog, [{ sku: 'mug-green', qty: 2 }]);
  assert.equal(clampOffer(1, cart), 24);
  assert.equal(clampOffer(999, cart), 36);
  assert.equal(clampOffer(NaN, cart), 36);
  assert.equal(clampOffer(30.123, cart), 30.12);
});

test('a bid at or above list is accepted at list, never more', () => {
  const cart = priceCart(catalog, [{ sku: 'mug-green', qty: 2 }]);
  assert.deepEqual(decide(cart, {}, 40).total, 36);
  assert.equal(decide(cart, {}, 40).status, 'accepted');
});

test('first fair bid gets met halfway, second is accepted', () => {
  const cart = priceCart(catalog, [{ sku: 'mug-green', qty: 2 }]);
  const r1 = decide(cart, {}, 28);
  assert.equal(r1.status, 'counter');
  assert.equal(r1.total, 32);
  const r2 = decide(cart, { round: 1, lastCounter: r1.total }, 29);
  assert.equal(r2.status, 'accepted');
  assert.equal(r2.total, 29);
});

test('lowball bids walk toward the floor, then get a final offer, never below floor', () => {
  const cart = priceCart(catalog, [{ sku: 'mug-green', qty: 2 }]);
  let state = {};
  const seen = [];
  for (let i = 0; i < DEFAULT_POLICY.maxRounds; i++) {
    const r = decide(cart, state, 5);
    seen.push(r);
    assert.ok(r.total >= cart.floorTotal, `round ${r.round} offered ${r.total}`);
    state = { round: r.round, lastCounter: r.total, final: r.status === 'final' };
  }
  assert.equal(seen.at(-1).status, 'final');
  assert.equal(seen.at(-1).total, 24);
  const after = decide(cart, state, 20);
  assert.equal(after.status, 'declined');
  assert.equal(decide(cart, state, 24).status, 'accepted');
});

test('no sequence of bids ever lands under the floor (randomised)', () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let trial = 0; trial < 2000; trial++) {
    const sku = catalog[Math.floor(rand() * catalog.length)];
    const qty = 1 + Math.floor(rand() * Math.min(3, sku.stock));
    const cart = priceCart(catalog, [{ sku: sku.sku, qty }]);
    let state = {};
    for (let i = 0; i < 5; i++) {
      const bid = Math.round(rand() * cart.listTotal * 1.2 * 100) / 100;
      const r = decide(cart, state, bid);
      if (r.status !== 'declined') assert.ok(r.total >= cart.floorTotal, JSON.stringify({ cart, r }));
      if (r.status === 'accepted') assert.ok(r.total <= cart.listTotal);
      state = { round: r.round, lastCounter: r.total, final: state.final || r.status === 'final' };
    }
  }
});

test('asking for a price without a bid returns the current price', () => {
  const cart = priceCart(catalog, [{ sku: 'bowl', qty: 1 }]);
  const r = decide(cart, {}, undefined);
  assert.equal(r.status, 'counter');
  assert.equal(r.total, 25.5);
});

test('allocate makes item total minus discount equal the agreed total', () => {
  const cart = priceCart(catalog, [{ sku: 'bowl', qty: 2 }, { sku: 'mug-green', qty: 1 }]);
  const a = allocate(cart, 60.01);
  assert.equal(a.itemTotal, 69);
  assert.equal(Math.round((a.itemTotal - a.discount) * 100), 6001);
});
