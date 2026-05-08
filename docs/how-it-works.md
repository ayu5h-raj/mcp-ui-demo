# How it works

End-to-end mental model of the demo: how the MCP server, Claude Desktop, and the rendered iframes talk to each other to make Pattern B (no LLM in the loop on iframe interactions) work.

## The four parties

```
┌──────────┐      ┌────────────────────┐      ┌────────────────┐      ┌─────────────────┐
│   You    │ ◄──► │   Claude Desktop   │ ◄──► │   MCP Server   │      │  Iframe(s)      │
│ (typing) │      │   (host process)   │      │  (your code)   │ ◄──► │  rendered HTML  │
└──────────┘      │   spawns server,   │      │  cart state    │      │  in sandboxed   │
                  │   renders iframes  │      │  tool handlers │      │  <iframe>       │
                  └─────────┬──────────┘      └────────┬───────┘      └────────┬────────┘
                            │                          │                       │
                            │   stdio (JSON-RPC)       │                       │
                            └──────────────────────────┘                       │
                            │                                                  │
                            │   postMessage (sandboxed iframe ↔ host window)   │
                            └──────────────────────────────────────────────────┘
```

Three communication channels. The MCP Server **never talks directly** to the iframe — Claude Desktop is the broker.

---

## Step 1: Startup (one-time)

```
Claude Desktop launches → reads claude_desktop_config.json → spawns:

  /opt/homebrew/bin/node  node_modules/tsx/dist/cli.mjs  src/server.ts
                                                          │
                                                          ▼
                                            buildServer() runs:

   ┌──────────────────────────────────────────────────────────────────────┐
   │   await createUIResource({                                           │
   │     uri: 'ui://mcp-ui-demo/template/restaurant-card',                │
   │     content: { type: 'rawHtml', htmlString: RESTAURANT_CARD_TEMPLATE},│
   │     adapters: { mcpApps: { enabled: true } },  ◄── injects ~16KB     │
   │   })                                              of bridge script   │
   │                                                   into the HTML      │
   │                                                                      │
   │   registerAppResource(server, 'restaurant_card_ui', uri, ...)        │
   │   registerAppTool(server, 'show_restaurant_card', {                  │
   │     _meta: { ui: { resourceUri: uri } }   ◄── this is the magic      │
   │   })                                                                 │
   └──────────────────────────────────────────────────────────────────────┘

      Same for: order-form template + view_cart template.
      Plus regular tools: show_menu_page, add_to_cart, clear_cart.

Then Claude Desktop calls tools/list and resources/list:

   Claude Desktop ──► server: tools/list
   server ──► Claude Desktop: [
     { name: 'show_restaurant_card',
       _meta: { ui: { resourceUri: 'ui://...restaurant-card' } }  ◄── flag
     },
     { name: 'show_order_form', ... resourceUri: 'ui://...order-form' },
     { name: 'view_cart',       ... resourceUri: 'ui://...cart' },
     { name: 'show_menu_page' },     ◄── no ui meta = plain tool
     { name: 'add_to_cart' },        ◄── no ui meta = plain tool
     { name: 'clear_cart' }          ◄── no ui meta = plain tool
   ]
```

The `_meta.ui.resourceUri` is what tells Claude Desktop "when this tool is called, render the linked resource as an MCP App with bridge support, not as plain text."

---

## Step 2: User asks for the order form (Pattern A — LLM is in the loop)

```
You: "Show me the order form for r1"

   ┌──────────┐    1. text             ┌──────────────┐
   │   You    │ ─────────────────────► │ Claude (LLM) │
   └──────────┘                        └──────┬───────┘
                                              │ 2. decides to call show_order_form(r1)
                                              ▼
                                    ┌────────────────────┐
                                    │  Claude Desktop    │
                                    └──┬─────────────────┘
                                       │ 3. tools/call: show_order_form, args={restaurantId:'r1'}
                                       ▼
                                  ┌──────────┐
                                  │ Server   │  buildOrderFormUI? No — it's a registered template.
                                  └──┬───────┘  Just look up the restaurant data.
                                     │ 4. result: { content: [{type:'text', text: '{"restaurant":{"id":"r1",...}}'}] }
                                     ▼
                              ┌────────────────────┐
                              │  Claude Desktop    │  Sees _meta.ui.resourceUri on the tool def.
                              └──┬─────────────────┘  → fetches the linked resource:
                                 │ 5. resources/read: ui://...order-form
                                 ▼
                            ┌──────────┐
                            │ Server   │
                            └──┬───────┘
                               │ 6. resource: { mimeType: 'text/html;profile=mcp-app',
                               │               text: '<html>... ORDER_FORM_TEMPLATE + adapter ...</html>' }
                               ▼
                       ┌────────────────────┐
                       │  Claude Desktop    │
                       │                    │  7. Mounts iframe with the HTML.
                       │   ┌──────────────┐ │  8. Posts ui-lifecycle-iframe-render-data
                       │   │   <iframe>   │ │       with toolInput={restaurantId:'r1'} and
                       │   │              │ │       toolOutput={content:[{text: JSON-restaurant}]}
                       │   │  template +  │ │
                       │   │  adapter     │ │  9. iframe's RENDER_LIFECYCLE_JS:
                       │   │              │ │      - parses toolOutput.content[0].text → JSON
                       │   │  applyData() │ │      - calls applyData(data) → populates DOM
                       │   │              │ │      - fires reportSize() → iframe grows
                       │   └──────────────┘ │
                       └────────────────────┘
```

Key insight: the **template is fixed**, the **data flows in via the lifecycle event**. One template can render any restaurant.

---

## Step 3: You click "Add to Cart" (Pattern B — Claude is NOT in the loop)

```
You click "Add to Cart" inside the iframe

   ┌──────────────────────────────┐
   │  iframe / template JS:       │
   │                              │
   │  callServerTool(             │     A. iframe builds postMessage:
   │    'add_to_cart',            │     {
   │    {restaurantId, items}     │       type: 'tool',
   │  )                           │       messageId: 'tool-1746...',
   │                              │       payload: {
   │  ─ window.parent.postMessage │         toolName: 'add_to_cart',
   │                              │         params: { restaurantId, items }
   └──────────────┬───────────────┘       }
                  │                     }
                  │ B. postMessage(...)
                  ▼
        ┌───────────────────────────────────┐
        │  Claude Desktop's MCP-UI bridge   │  C. Adapter (auto-injected by SDK
        │  (in the host window)             │     when adapters.mcpApps.enabled=true)
        │                                   │     translates 'tool' message into:
        └──────────────┬────────────────────┘     tools/call(add_to_cart, args)
                       │ D. tools/call: add_to_cart, {restaurantId:'r1', items:[...]}
                       ▼
                  ┌──────────┐
                  │  Server  │  E. add_to_cart handler:
                  │          │     - mutates cart state (closure scope per-session)
                  │  cart=[] │     - returns { content: [{type:'text', text: 'Added 3...'}] }
                  │  push()  │
                  └──┬───────┘
                     │ F. result { content:[{text:'Added 3 items from Pizza Paradiso. Cart now has 3 items, total $28.97.'}] }
                     ▼
        ┌───────────────────────────────────┐
        │  Claude Desktop bridge            │  G. Wraps the tool result back as
        └──────────────┬────────────────────┘     a postMessage:
                       │                          { type: 'ui-message-response',
                       │                            messageId: 'tool-1746...',
                       │                            payload: { response: { content:[...] } } }
                       ▼
   ┌──────────────────────────────┐
   │  iframe                      │  H. Promise from callServerTool resolves
   │                              │     with the response.
   │  await callServerTool(...)   │
   │  ackEl.textContent =         │  I. iframe shows green "✓ Pattern B: Added 3 items..."
   │    '✓ Pattern B: ' + text    │     in the ack banner. Submit button → "Added to Cart ✓".
   └──────────────────────────────┘
```

Notice what's missing: **no LLM inference, no chat turn, no token cost**. The form click → server tool call → result → UI update happens in ~50 ms entirely between iframe ↔ host ↔ server.

But the **server's cart state is now mutated**.

---

## Step 4: Reading state back through Claude

```
You: "What's in my cart?"

   ┌──────────┐    1. text             ┌──────────────┐
   │   You    │ ─────────────────────► │ Claude (LLM) │
   └──────────┘                        └──────┬───────┘
                                              │ 2. calls view_cart()
                                              ▼
                                       ┌──────────┐
                                       │  Server  │  3. view_cart handler:
                                       │          │     - reads cart state
                                       │  cart=[3]│     - returns { content:[{text: JSON-cart}] }
                                       └──┬───────┘
                                          │ 4. result text contains the cart Claude added in Step 3
                                          ▼
                                  Claude Desktop renders the linked cart template
                                  with toolOutput → iframe shows the items.
```

The cart Claude reads back here was put there by your click in Step 3 — **a click in the iframe that Claude was never told about, on the same MCP server process, in the same closure-scoped `cart` array**.

---

## Why "same MCP server process" matters

```
Claude Desktop config:
  command: /opt/homebrew/bin/node
  args:    [tsx-cli.mjs, src/server.ts]
  env:     MCP_TRANSPORT=stdio

  ─────────────────────────────────────────────────────
  When Claude Desktop launches → spawns ONE node process.
  All your tool calls (Step 2, Step 3, Step 4) hit the
  SAME process → same buildServer() closure → same cart array.

  When you Cmd+Q Claude Desktop → process killed → cart gone.
  ─────────────────────────────────────────────────────
```

For HTTP transport, the equivalent boundary is the MCP **session** (one cart per session, scoped by `mcp-session-id` header).

---

## Auto-resize (the last piece)

```
Iframe content grows ──► ResizeObserver fires ──► reportSize()
                                                       │
                                                       │ postMessage
                                                       ▼
                                         { type: 'ui-size-change',
                                           payload: { width, height } }
                                                       │
                                                       ▼
                                         Adapter translates to:
                                         ui/notifications/size-changed
                                                       │
                                                       ▼
                                         Claude Desktop grows iframe
                                         to match content height.
```

---

## TL;DR mental model

| Question | Answer |
|---|---|
| Who knows about the cart? | The MCP server (in-memory closure). Nothing else. |
| Who renders the iframe? | Claude Desktop, after fetching the linked resource. |
| Who put the data into the iframe? | Claude Desktop, via the `ui-lifecycle-iframe-render-data` postMessage. |
| What does Claude (the LLM) actually see? | Tool input args + tool result text. Never the rendered HTML. |
| When does Claude make a turn? | When *you* type to it (Steps 2, 4). Not when you click in an iframe (Step 3). |
| Why are templates generic, not per-restaurant? | Because `_meta.ui.resourceUri` is fixed at registration. Data flows in at call time via the lifecycle event. |
| What does the "adapter" do? | Translates legacy `{type:'tool',...}` postMessages → real MCP `tools/call`s, and translates results back as `ui-message-response`. Without it, Pattern B doesn't work. |
| Why two MIME types? | `text/html` = legacy (rendered as basic iframe). `text/html;profile=mcp-app` = MCP App with bridge support, host knows to set up the postMessage routing. |

Phase 2 (Swiggy widgets) will use this exact same skeleton — just with real APIs instead of mock data and Swiggy's own widget templates instead of ours.
