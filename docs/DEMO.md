# Demo video script (2 min 45 s)

Record at 1440p with the browser at 125% zoom. Two windows side by side: the shop with the buyer's agent on the left, the merchant view on the right. Use PayPal sandbox, never live.

## 0:00 to 0:15. The problem

On screen: Ìkòkò Clay Studio, a small pottery shop. View source, scroll to the one line.

> "AI agents are starting to shop for people, but almost no small shop can talk to them, and none of them can bargain. This shop has no AI in it at all. It has one line."

## 0:15 to 0:35. One line

Highlight `<script src=".../haggle.js" data-shop="ikoko">`. Reload. The "Agent-ready" badge appears.

> "That line registers five WebMCP tools in the page: search, product details, request an offer, accept an offer, and check the order. Any agent in the browser can now use the shop."

## 0:35 to 1:25. The agent haggles

In the agent (ChatGPT's browser, or Chrome with WebMCP), type:

> "Buy me two green mugs as a gift. Try to keep it under $30."

Let the activity feed on the page tick through: search, request_offer at $25, the shop counters at $30.50 with its reason, the agent bids $29, accepted.

> "The agent bid $25. The shop's own deal-maker countered. It knows the floor price, the agent never does. Two rounds later they agree on $29."

## 1:25 to 1:55. The person pays in PayPal

The sheet appears: "Your agent got you a deal. Was $36, you save $7." Click the PayPal button, approve in the sandbox window.

> "The agent can't spend money. The person sees the deal and approves it in PayPal themselves. The order is exactly $29, with the discount itemised in PayPal."

Feed shows "order paid".

## 1:55 to 2:30. What the merchant sees

Switch to the merchant view. Point at the new paid order, the negotiation story, and Missed demand.

> "The merchant sees every agent order, every round of every negotiation, and something no shop sees today: what agents asked for and couldn't find, and the prices they wanted. Here, three agents looked for a teapot."

Double-click a floor, change it, show the next bid getting a different answer if time allows.

## 2:30 to 2:45. Close

> "One line makes a shop agent-ready. The shop bargains safely, PayPal closes the sale, and the merchant learns what agents want. It's open source and MIT licensed."

## Before recording

- Reset the server so the dashboard starts clean, then run one search for "teapot" from two or three agents (or `haggle.call`) so Missed demand has rows.
- Have the PayPal sandbox buyer account signed in, in the window you'll approve from.
- If no WebMCP agent is available, drive the same calls from the console with `haggle.call(...)` and say so on screen.
