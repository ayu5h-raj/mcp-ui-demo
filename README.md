# mcp-ui-demo

> 🎮 **Try the live interactive demo →** https://ayu5h-raj.github.io/mcp-ui-demo/
> &nbsp;&nbsp;(no install needed; runs in your browser, mocks the equivalent MCP tool call on every click)

A minimal demo of [MCP-UI](https://mcpui.dev/): one TypeScript MCP server, six tools, three rendering modes plus **Pattern B** (iframe → server tool call with no LLM round-trip), inside a sandboxed iframe in the host (Claude Desktop, ui-inspector, etc.).

## What you get

| Tool | Kind | What it shows |
|---|---|---|
| `show_restaurant_card` | UI: `rawHtml` | A styled restaurant card with rating / ETA / price — pure inline-CSS HTML rendered in a sandboxed iframe. |
| `show_menu_page` | UI: `externalUrl` | The cuisine's Wikipedia page embedded as an iframe — host loads any URL you hand it. |
| `show_order_form` | UI: `rawHtml` + Pattern B | Interactive order form. Clicking "Add to Cart" calls the `add_to_cart` tool **directly** via the MCP Apps adapter — no LLM round-trip. Server cart state updates live. |
| `view_cart` | UI: `rawHtml` | Renders the current shopping cart (items grouped by restaurant + total) as a styled UI. |
| `add_to_cart` | data | Appends items to the session cart. Called from the order-form iframe (Pattern B) or directly by Claude. |
| `clear_cart` | data | Empties the session cart. |

All UI tools that take a restaurant accept `restaurantId` ∈ `{r1, r2, r3}` — Pizza Paradiso, Sushi Zen, Curry House (Swiggy-themed warm-up for Phase 2).

## Pattern A vs Pattern B

- **Pattern A** (Claude in the loop): UI posts a `prompt` intent → host forwards as a follow-up user turn → Claude reads it and decides what to call. Slow, token-expensive, but flexible.
- **Pattern B** (direct tool call): UI sends `{type: 'tool', payload: {toolName, params}}` → host routes to the MCP server directly → server returns result to the iframe. Fast, deterministic, free. **This is what production apps (Excalidraw, Swiggy widgets) use.**

This demo wires `show_order_form` for Pattern B end-to-end. Click "Add to Cart" → cart state updates server-side → ask Claude "what's in my cart?" and it calls `view_cart` to read the same state back.

## Quickstart

```bash
pnpm install
pnpm dev          # MCP server on http://localhost:3000/mcp (Streamable HTTP)
```

That's it on the server side. Now point a viewer at it.

### Option A — view in `ui-inspector` (recommended for dev)

```bash
# in another directory, once:
git clone https://github.com/idosal/ui-inspector
cd ui-inspector
pnpm install
pnpm dev
```

Open the inspector URL it prints, set:
- **Transport Type**: `Streamable HTTP`
- **URL**: `http://localhost:3000/mcp`

Click **Connect** → three tools appear in the left pane → click each one → rendered UI shows in the right pane. Click "Place Order" in `show_order_form` and watch the intent appear in the inspector's message log.

### Option B — view in Claude Desktop

1. Edit `~/Library/Application Support/Claude/claude_desktop_config.json` and merge in the snippet from [`examples/claude_desktop_config.json`](examples/claude_desktop_config.json), substituting `/ABSOLUTE/PATH/TO/mcp-ui-demo` with the real path to this folder.
2. Restart Claude Desktop.
3. Open a new chat and ask: **"Show me the restaurant card for r1"** — Claude calls `show_restaurant_card` and the card renders inline in chat.
4. Try **"Show me the order form for r2"** — pick items, click **Place Order**, the intent surfaces back as a tool message Claude can react to.

The Claude Desktop config uses stdio transport — the server is the same code, just launched with `MCP_TRANSPORT=stdio`.

## How it works

```
src/server.ts          ← everything: server bootstrap + 3 tools + mock data
docs/superpowers/specs/ ← design spec
examples/              ← Claude Desktop config snippet
```

The server is a single `~270`-line TypeScript file:

1. Mock restaurant data inline at the top.
2. Two HTML builders (`buildRestaurantCardHTML`, `buildOrderFormHTML`) that produce inline-styled HTML strings.
3. `buildServer()` registers the three tools — each one calls `createUIResource(...)` from [`@mcp-ui/server`](https://www.npmjs.com/package/@mcp-ui/server) and returns it as the tool's `content`.
4. Bootstrap branches on `MCP_TRANSPORT`: stdio for Claude Desktop, Streamable HTTP for ui-inspector / web hosts.

## Notes

- The `externalUrl` tool fetches the URL server-side at tool-call time (the SDK injects a `<base>` tag for relative-path resolution), so the demo machine needs network access for tool 2 to work.
- Wikipedia is used because most public sites set `X-Frame-Options: DENY` and refuse to be iframed. Wikipedia doesn't. Swap the URLs in `restaurants[…].cuisineWikiUrl` to anything that allows iframing.
- This is a demo — no auth, no persistence, no error handling beyond what the SDK / framework gives for free.

## How it works

See [`docs/how-it-works.md`](docs/how-it-works.md) — end-to-end mental model with ASCII flow diagrams: startup, Pattern A (LLM in the loop), Pattern B (no LLM round-trip on iframe interaction), state reads, and auto-resize.

## Design spec

See [`docs/superpowers/specs/2026-05-09-mcp-ui-demo-design.md`](docs/superpowers/specs/2026-05-09-mcp-ui-demo-design.md) for the design rationale, scope decisions, and what was deliberately left out.

## License

MIT (or whatever you prefer — this is demo code).
