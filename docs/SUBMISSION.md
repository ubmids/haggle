# Submission write-up

## Name

haggle: one line makes any shop agent-ready, and lets it bargain

## Tagline

Paste one script tag. AI agents can find, haggle for and check out your products, the shop never goes under your floor, and the person pays in PayPal.

## Inspiration

Agents are starting to shop for people, but small shops have no way to talk to them, and every agent checkout so far assumes a fixed price. In markets like Lagos, and in most small businesses, the price is a conversation. We wanted a shop to be able to have that conversation safely, without its owner writing any AI code.

## What it does

- **One line.** `<script src=".../haggle.js" data-shop="...">` registers five WebMCP tools in the page: `search_products`, `get_product`, `request_offer`, `accept_offer` and `check_order`. Agents in ChatGPT's browser or Chrome with WebMCP can use them directly. The same tools work over HTTP for agents without WebMCP.
- **The shop bargains.** A buyer's agent can ask for a price or bid. The shop's deal-maker counters, explains itself, offers more for bundles, and closes within three rounds. It never goes under the merchant's floor, and the floor is never shown to the agent.
- **PayPal closes the sale.** An accepted offer becomes a PayPal Orders v2 order for exactly the agreed amount, with the discount itemised. The page shows the person "Your agent got you a deal: was $36, you save $7" with PayPal buttons. The agent can start checkout but only the person can approve the payment.
- **Anyone can watch it work.** WebMCP isn't on by default in browsers yet, so the demo shop has a "Watch an agent buy" box. A buyer agent (Claude, or a rules buyer without an API key) shops through the same tools in the page, haggles, and stops at the PayPal sheet. The server checks each of its steps against the person's budget and the offers the shop really made.
- **The merchant learns.** An AG Grid view shows every agent order, the story of every negotiation, and missed demand: products agents searched for and couldn't find, and prices they wanted that the shop turned down. Merchants can change a floor in the grid and the next bid uses it.

## How we built it

- Node and Express backend, plain JavaScript script tag with no build step.
- WebMCP `document.modelContext.registerTool`, with the older `navigator.modelContext` as a fallback.
- PayPal Orders v2 in sandbox: OAuth client credentials, orders with an item and discount breakdown, idempotency keys, approval through PayPal's JS SDK buttons, and server-side capture. The client refuses any non-sandbox PayPal host.
- Claude (Anthropic API) words the shop's counters in the shop's own voice, using structured output. A deterministic rules engine sets the price limits and every model answer is clamped to them, so the AI can make the shop persuasive but can never give the stock away. If the model refuses, errors or times out, the rules engine answers.
- AG Grid Community for the merchant view, with the theming API and dark mode.
- 41 automated tests, including a randomized test that no sequence of bids ever goes under a floor, a full purchase in mock PayPal mode, a check that search results never leak floors, the script tag running in a simulated page with a fake WebMCP registry, and the demo buyer haggling a purchase while never going over budget or accepting an offer the shop never made.

## Challenges

- Keeping an AI negotiator safe. We split the job: rules decide what is allowed, the model only decides how to say it, and its numbers are clamped.
- Making PayPal's totals add up exactly when a negotiated price is spread across several items and quantities.
- WebMCP is still behind a flag or origin trial in Chrome, so the script tag works with or without it and tells the person which.

## What we're proud of

A shop with no AI code at all can bargain with an agent and close a real PayPal sandbox sale, and its owner can see demand nobody could see before.

## What's next

Reading the catalog from a shop's existing product markup (JSON-LD), shop-wide rules like "free shipping over $50", PayPal Vault for returning buyers, and a hosted dashboard for many shops.

## AI tools used

- Claude (Anthropic API) inside the product, to word the shop's negotiation replies.
- WebMCP, for agents to call the shop's tools.
- Claude Code helped write the code and tests.

## Try it

- Live demo: https://haggle-jet.vercel.app
- Merchant view: https://haggle-jet.vercel.app/merchant/
- Code: https://github.com/ubmids/haggle
- Run locally: `npm install && npm run dev`, then open http://localhost:3000. No PayPal account needed in mock mode; set `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` for sandbox.

## Built with

javascript, node.js, express, webmcp, paypal, paypal-orders-api, anthropic, claude, ag-grid
