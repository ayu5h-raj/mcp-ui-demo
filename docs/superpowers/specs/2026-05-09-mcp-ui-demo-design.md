# MCP-UI Demo — Design Spec

**Date:** 2026-05-09
**Goal:** A minimal demo showcasing what MCP-UI can do via a single TypeScript MCP server with three tools — a static rawHtml card, an externalUrl iframe, and an interactive rawHtml form that posts intents back to the host. Viewable in `ui-inspector` and Claude Desktop.

**Note (2026-05-09):** Original spec said "three rendering modes (rawHtml, externalUrl, remoteDom)". The current `@mcp-ui/server` SDK only exposes `rawHtml | externalUrl` — there is no `remoteDom` content type. Replaced the third tool with an interactive rawHtml form (postMessage intent back to host) which preserves the "three meaningfully different demo tools" framing within what the SDK actually supports.

## Why

The user discovered MCP-UI and wants to share it. This demo is a teaching artifact: shortest possible path from "what is MCP-UI?" to "I just clicked a tool and got a rendered widget." Phase 2 (separate spec, separate repo work) will use Swiggy's MCP widget builder for a real-world example; this demo is the warm-up and uses a Swiggy-flavored theme (food / restaurants) to make the segue smooth.

## Scope

**In scope:**
- One TypeScript MCP server implementing three tools — one per rendering mode
- Dual transport: Streamable HTTP (for `ui-inspector`) and stdio (for Claude Desktop)
- Inline mock data for restaurants and menu items
- README with run + view instructions
- Sample `claude_desktop_config.json` snippet committed to the repo

**Out of scope:**
- Real APIs, persistent storage, authentication
- A custom Vite/React client (`ui-inspector` is the viewer)
- Production-grade error handling, logging, observability
- Multi-server orchestration, deployment, hosting
- Phase 2 Swiggy integration (handled in a separate spec)

## Architecture

```
┌──────────────────────────┐         ┌─────────────────────────┐
│  Viewer                  │  MCP    │  MCP Server             │
│  (ui-inspector OR        │ ◄─────► │  (src/server.ts)        │
│   Claude Desktop)        │         │                         │
└──────────────────────────┘         │  • show_restaurant_card │
            │                        │    → rawHtml UIResource │
            │ renders inside         │  • show_menu_page       │
            │ sandboxed iframe       │    → externalUrl UIRes  │
            ▼                        │  • show_item_list       │
   [card / iframe / list]            │    → remoteDom UIRes    │
                                     └─────────────────────────┘
```

**Transport selection** — the server entrypoint inspects an env var (`MCP_TRANSPORT`) or CLI flag:
- Default → Streamable HTTP on `http://localhost:3000/mcp` (consumed by `ui-inspector`)
- `MCP_TRANSPORT=stdio` → stdio transport (consumed by Claude Desktop spawning the process)

Same tool code, same handlers — only the transport layer differs.

## File layout

```
mcp-ui-demo/
├── package.json
├── tsconfig.json
├── README.md
├── .gitignore
├── docs/
│   └── superpowers/specs/2026-05-09-mcp-ui-demo-design.md   # this file
├── examples/
│   └── claude_desktop_config.json     # copy-paste snippet
└── src/
    └── server.ts                      # everything: bootstrap + 3 tools + mock data
```

One source file. Mock data lives as TS constants at the top of `src/server.ts`. No `tools/` or `data/` folders — keeping the whole demo readable in a single file is part of the point.

## Components

### `src/server.ts` (~220 lines)

Sections, top to bottom:

1. **Imports** (~10 lines) — `@modelcontextprotocol/sdk`, `@mcp-ui/server`, `express`, `zod`.
2. **Mock data** (~30 lines) — three restaurants, four menu items each, hardcoded objects.
3. **HTML template helper** (~30 lines) — function that builds the rawHtml restaurant card with inline `<style>`. Takes a restaurant object, returns an HTML string.
4. **Remote-DOM script builder** (~40 lines) — function that builds the JS script string for the remoteDom mode: declares `<ui-text>` and `<ui-button>` for each menu item, wires the button click to `postMessage` an intent back to the host.
5. **Tool registrations** (~60 lines) — three calls to register each tool, each producing a `UIResource` via `createUIResource(...)`.
6. **Transport bootstrap** (~50 lines) — branch on `MCP_TRANSPORT`; either start Express HTTP server with the MCP Streamable HTTP handler, or wire stdio transport.

### Tool 1: `show_restaurant_card` (rawHtml)
- **Input schema** (zod): `{ restaurantId: z.enum(['r1','r2','r3']) }`
- **Behavior**: looks up restaurant, fills HTML template, wraps in `createUIResource({ uri: 'ui://swiggy-preview/restaurant/<id>', content: { type: 'rawHtml', htmlString }, encoding: 'text' })`.
- **Visual**: card with restaurant name, cuisine tag, ⭐ rating, ETA badge, price-range pill, gradient hero placeholder. Pure inline CSS, no external assets.

### Tool 2: `show_menu_page` (externalUrl)
- **Input schema**: `{ restaurantId: z.enum(['r1','r2','r3']) }`
- **Behavior**: returns `createUIResource({ uri: 'ui://swiggy-preview/menu/<id>', content: { type: 'externalUrl', iframeUrl: '<URL>' }, uiMetadata: { 'preferred-frame-size': ['100%', '600px'] } })`.
- **URL choice**: Wikipedia article on the restaurant's cuisine (e.g. `https://en.wikipedia.org/wiki/Pizza`) — known iframe-friendly. Documented in README as "swap for any URL that doesn't set X-Frame-Options: DENY".
- **Visual**: full Wikipedia page rendered in a sandboxed iframe inside the inspector.

### Tool 3: `show_order_form` (rawHtml + postMessage)
- **Input schema**: `{ restaurantId: z.enum(['r1','r2','r3']) }`
- **Behavior**: returns `createUIResource({ uri: 'ui://mcp-ui-demo/order-form/<id>', content: { type: 'rawHtml', htmlString }, encoding: 'text' })`. The HTML contains checkboxes for menu items, a live total, and a "Place Order" button. On click, an inline `<script>` calls `window.parent.postMessage({ type: 'intent', payload: { intent: 'place-order', restaurantId, items, total } }, '*')` — the host (ui-inspector / Claude Desktop) receives the intent.
- **Visual**: order form with item checkboxes, running total, and submit button. After submission, an inline acknowledgment shows; the host's message log captures the intent.
- **Why interactive rawHtml instead of remoteDom**: the current SDK only supports `rawHtml | externalUrl`. Interactive rawHtml + `postMessage` is the canonical pattern for guest→host communication (see python-server-demo's `show_action_html`).

## Data flow

1. User clicks a tool in the viewer.
2. Viewer sends MCP `tools/call` with input args over the chosen transport.
3. Server tool handler builds the `UIResource` and returns it as the tool's content.
4. Viewer receives the result, sees the `mimeType: text/html;profile=mcp-app`, mounts the resource in a sandboxed iframe.
5. (Tool 3 only) iframe `<ui-button>` click → `postMessage` → viewer's intent log.

No state on the server. Each tool call is independent.

## Error handling

- **Unknown `restaurantId`**: zod schema constrains to enum, so invalid input fails at the protocol layer with a clear error. No custom handling needed.
- **Iframe URL fails to load**: the host's iframe sandbox handles this — the user sees the failed-load page inside the iframe. Documented in README.
- **Transport startup failure**: log and exit — these are dev-loop errors, not runtime user errors.

No retries, no fallbacks. This is a demo, not a production service.

## Testing

- **Manual smoke test** (the demo itself): run server, run `ui-inspector`, click each tool, confirm UI renders. Documented in README as the verification flow.
- **No automated tests** — the cost-benefit doesn't pencil out for a one-file demo whose entire value is "the rendered UI looks right." A snapshot test would only check the HTML string equals what we wrote. Visual confirmation in the viewer *is* the test.

## Run + view flow

**Dev / demo path 1 — ui-inspector:**
```bash
pnpm install
pnpm dev                 # MCP server on http://localhost:3000/mcp

# in another terminal:
git clone https://github.com/idosal/ui-inspector
cd ui-inspector && pnpm install && pnpm dev
# open inspector URL, transport: Streamable HTTP, URL: http://localhost:3000/mcp, Connect
```

**Dev / demo path 2 — Claude Desktop:**
1. Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:
   ```json
   {
     "mcpServers": {
       "swiggy-preview": {
         "command": "npx",
         "args": ["-y", "tsx", "/absolute/path/to/mcp-ui-demo/src/server.ts"],
         "env": { "MCP_TRANSPORT": "stdio" }
       }
     }
   }
   ```
2. Restart Claude Desktop.
3. In a new chat: "show me restaurant r1" → Claude calls `show_restaurant_card` → card renders inline.

## Dependencies

- `@modelcontextprotocol/sdk` — MCP server primitives (`McpServer`, transports)
- `@mcp-ui/server` — `createUIResource` helper
- `express` — HTTP server for the Streamable HTTP transport
- `zod` — input schema validation
- `tsx` (dev) — direct TypeScript execution, no build step
- `typescript` (dev) — for `tsconfig` + types only

Pin to versions latest as of 2026-05-09 (`@mcp-ui/server@^6.1.0`, `@modelcontextprotocol/sdk@^1.29.0`).

## Open questions / risks

- **Wikipedia URL stability**: not really a risk — these articles have been there for 20 years. README will note the URL is swappable.
- **Claude Desktop stdio path**: the absolute path in `claude_desktop_config.json` is user-specific. README shows where to substitute.
- **`createUIResource` for `externalUrl` does a fetch**: the SDK fetches the URL server-side and injects a `<base>` tag for relative-path resolution. Means the demo needs network access on each call to Tool 2. Acceptable for a demo; documented in README.

## What success looks like

A new viewer can clone this repo, run two `pnpm` commands, and within 60 seconds see three rendered MCP-UI widgets they can click on. They walk away understanding what MCP-UI is and how the three rendering modes differ.
