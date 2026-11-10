// Demo merchant. A real install would load this from the merchant's own
// product feed (or the page's schema.org data); prices and floors stay server-side.

export const SHOPS = {
  ikoko: {
    id: 'ikoko',
    name: 'Ìkòkò Clay Studio',
    voice: 'A two-person pottery studio in Lagos. Speaks plainly and kindly, likes repeat customers.',
    currency: 'USD',
    policy: {},
    catalog: [
      { sku: 'mug-green', name: 'Moss green mug', price: 18, floor: 12, stock: 14, color: 'green', kind: 'mug', description: 'Stoneware mug, 350 ml, moss green glaze.', image: '/shop/img/mug-green.svg' },
      { sku: 'mug-indigo', name: 'Indigo adire mug', price: 22, floor: 15, stock: 8, color: 'blue', kind: 'mug', description: 'Hand-stamped adire pattern in indigo, 350 ml.', image: '/shop/img/mug-indigo.svg' },
      { sku: 'mug-sand', name: 'Sand speckle mug', price: 16, floor: 11, stock: 20, color: 'beige', kind: 'mug', description: 'Speckled sand glaze, 300 ml, fits a pour-over.', image: '/shop/img/mug-sand.svg' },
      { sku: 'bowl-terracotta', name: 'Terracotta soup bowl', price: 26, floor: 18, stock: 6, color: 'orange', kind: 'bowl', description: 'Wide bowl for egusi or ramen, unglazed outside.', image: '/shop/img/bowl-terracotta.svg' },
      { sku: 'plate-ash', name: 'Ash dinner plate', price: 30, floor: 21, stock: 5, color: 'grey', kind: 'plate', description: '27 cm plate with a matte ash glaze.', image: '/shop/img/plate-ash.svg' },
      { sku: 'vase-ochre', name: 'Ochre bud vase', price: 34, floor: 25, stock: 3, color: 'yellow', kind: 'vase', description: 'Small vase, one stem, ochre drip glaze.', image: '/shop/img/vase-ochre.svg' },
    ],
  },
};

/** What an agent may see about a product: never the floor. */
export function publicProduct(p, currency) {
  const { floor, ...rest } = p;
  return { ...rest, currency, inStock: p.stock > 0 };
}
