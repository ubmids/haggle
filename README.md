# haggle

One script tag makes any online shop buyable by AI agents, and lets the shop negotiate.

```html
<script src="https://YOUR-HAGGLE-HOST/haggle.js" data-shop="ikoko" defer></script>
```

Paste that line into a shop page and the page registers five [WebMCP](https://github.com/webmachinelearning/webmcp) tools. A buyer's AI agent running in the browser (ChatGPT's browser, or Chrome with WebMCP turned on) can then search the catalog, ask for a price, haggle, and start a PayPal checkout. The person always approves the payment themselves in PayPal.

The shop answers with its own deal-maker. It counters bids, offers more for bundles, and never goes under the merchant's floor price. Agents never see the floor.

The merchant gets a dashboard of every agent order, every negotiation and the demand they missed: what agents searched for and couldn't find, and the prices they turned down.

## How a sale goes

1. The agent calls `search_products` with "green mug under $30".
2. It calls `request_offer` for two mugs with a $25 bid and a note ("buying two as a gift").
3. The shop's agent counters at $30.50 and explains why.
4. The agent bids $29 and the shop accepts.
5. `accept_offer` creates a PayPal order for exactly $29.00, with the discount shown in PayPal's breakdown, and the page shows the person a sheet: "Your agent got you a deal. Was $36, you save $7."
6. The person approves in PayPal. `check_order` captures the payment and the order shows as paid in the merchant view.

## The tools

| Tool | What it does |
| --- | --- |
| `search_products` | Search the catalog by words and an optional max price. Read-only. |
| `get_product` | One product's details, price and stock. Read-only. |
| `request_offer` | Ask the price for a cart, or bid on it. Returns `accepted`, `counter`, `final` or `declined`, an offer id and the shop's message. Pass `negotiation_id` to keep haggling. |
| `accept_offer` | Turn an offer into a PayPal order and show the person the approval sheet. |
| `check_order` | Check a PayPal order, and capture it once the person has approved. |

The same tools are on `window.haggle.call(name, args)` and at `POST /api/shops/:shop/tools/:tool`, so agents without WebMCP can still use them.

## How the deal-maker stays safe

- The price comes from a deterministic rules engine (`src/negotiate.js`): up to three rounds, a halfway counter, bundles can reach the floor, single items only go halfway from list to floor.
- When an Anthropic API key is set, Claude writes the shop's reply and may suggest a price, but the result is clamped back between the floor and the rules engine's counter. Refusals, errors and timeouts fall back to the rules. Accepted deals never go through the model.
- Floors are never sent to agents or the page. A test checks search results for leaks.
- PayPal runs in sandbox only. The client refuses any host that isn't `api-m.sandbox.paypal.com`.
- Payment is approved by the person in PayPal. An agent can start a checkout but can't finish one.

## Run it

```bash
npm install
npm run dev        # mock PayPal, no account needed
npm test
```

Then open `http://localhost:3000` for the demo shop and `http://localhost:3000/merchant/` for the merchant view.

### Environment

| Variable | Needed for |
| --- | --- |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | PayPal sandbox checkout. Without them it runs a mock checkout. |
| `PAYPAL_MODE` | `mock` forces the mock checkout even when keys are set. |
| `PUBLIC_URL` | The https address the app is hosted at, for PayPal's return links. |
| `ANTHROPIC_API_KEY` | Optional. Claude words the shop's counters. Without it the rules engine words them. |
| `HAGGLE_MODEL` | Optional. The Claude model, `claude-opus-5-5` by default. |
| `WEBMCP_OT_TOKEN` | Optional. A Chrome WebMCP origin trial token for the host. |
| `MERCHANT_KEY` | Optional. Locks the merchant view behind `?key=`. |
| `DEMO_BUYER` | `off` removes the demo buyer endpoint, for a real merchant's host. |
| `DEMO_BUYER_AI` | `off` keeps the demo buyer on the rules buyer even when an Anthropic key is set. Claude buyer steps are also capped at 300 an hour. |
| `PORT` | Port to listen on, 3000 by default. |

`render.yaml` deploys it to Render. Set the secrets in Render's dashboard.

## Try it with an agent

- **ChatGPT desktop browser:** open the hosted shop and ask "buy me two green mugs, try to keep it under $30".
- **Chrome:** turn on `chrome://flags/#enable-webmcp-testing` (or use an origin trial token), then use the Model Context Tool Inspector extension or any WebMCP agent on the shop page.
- **No WebMCP:** the demo shop has a "Watch an agent buy" box. It runs a buyer agent on the haggle server one step at a time and calls the shop's tools in the page, so the activity feed, the haggling and the PayPal sheet look exactly as they would with a real agent. With an Anthropic key, Claude decides each step; without one, a simple rules buyer does. The server checks every step: only the shop's tools, never over the stated budget, only offers the shop actually made, and it stops at PayPal. The tools also work from the console with `haggle.call('search_products', { query: 'mug' })`.

## Layout

```
public/haggle.js           the script tag: WebMCP tools, badge, activity feed, PayPal sheet
public/shop/               a plain demo shop with no AI in it
public/merchant/           the merchant view (AG Grid)
src/negotiate.js           pricing rules
src/shopAgent.js           Claude wording, clamped to the rules
src/buyerAgent.js          the demo buyer agent and the checks on its steps
public/shop/demo-buyer.js  the demo shop's "Watch an agent buy" box
src/paypal.js              PayPal Orders v2 sandbox client and the mock
src/service.js             tools, offers, orders, merchant data
src/server.js              Express app
```

MIT licensed.
