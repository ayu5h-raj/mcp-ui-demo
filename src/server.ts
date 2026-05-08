import express from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createUIResource } from '@mcp-ui/server';
import { registerAppTool, registerAppResource } from '@modelcontextprotocol/ext-apps/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

// ───────────────────────────────────────────────────────────────────────────
// Mock data — three restaurants, four items each.
// ───────────────────────────────────────────────────────────────────────────

type Restaurant = {
  id: 'r1' | 'r2' | 'r3';
  name: string;
  cuisine: string;
  rating: number;
  etaMin: number;
  priceRange: '$' | '$$' | '$$$';
  gradient: [string, string];
  cuisineWikiUrl: string;
  items: { name: string; price: number; emoji: string }[];
};

const restaurants: Record<Restaurant['id'], Restaurant> = {
  r1: {
    id: 'r1',
    name: 'Pizza Paradiso',
    cuisine: 'Italian',
    rating: 4.5,
    etaMin: 25,
    priceRange: '$$',
    gradient: ['#ff7e5f', '#feb47b'],
    cuisineWikiUrl: 'https://en.wikipedia.org/wiki/Pizza',
    items: [
      { name: 'Margherita Pizza', price: 12.99, emoji: '🍕' },
      { name: 'Pepperoni Pizza', price: 14.99, emoji: '🍕' },
      { name: 'Garlic Bread', price: 5.99, emoji: '🍞' },
      { name: 'Tiramisu', price: 7.99, emoji: '🍰' },
    ],
  },
  r2: {
    id: 'r2',
    name: 'Sushi Zen',
    cuisine: 'Japanese',
    rating: 4.8,
    etaMin: 35,
    priceRange: '$$$',
    gradient: ['#a8e6cf', '#3eb489'],
    cuisineWikiUrl: 'https://en.wikipedia.org/wiki/Sushi',
    items: [
      { name: 'Salmon Nigiri', price: 8.99, emoji: '🍣' },
      { name: 'Dragon Roll', price: 16.99, emoji: '🍱' },
      { name: 'Miso Soup', price: 4.99, emoji: '🍲' },
      { name: 'Edamame', price: 5.99, emoji: '🟢' },
    ],
  },
  r3: {
    id: 'r3',
    name: 'Curry House',
    cuisine: 'Indian',
    rating: 4.6,
    etaMin: 30,
    priceRange: '$',
    gradient: ['#ee9ca7', '#ffdde1'],
    cuisineWikiUrl: 'https://en.wikipedia.org/wiki/Curry',
    items: [
      { name: 'Butter Chicken', price: 13.99, emoji: '🍛' },
      { name: 'Garlic Naan', price: 3.99, emoji: '🫓' },
      { name: 'Samosa', price: 5.99, emoji: '🥟' },
      { name: 'Mango Lassi', price: 4.99, emoji: '🥭' },
    ],
  },
};

type CartLine = { restaurantId: Restaurant['id']; name: string; price: number; emoji: string };

// ───────────────────────────────────────────────────────────────────────────
// Generic UI templates — registered ONCE per server, data flows in via the
// MCP Apps `ui-lifecycle-iframe-render-data` event (toolInput + toolOutput).
// ───────────────────────────────────────────────────────────────────────────

// Common preamble that wires the render-data lifecycle plus auto-resize.
// Templates compose this with their own DOM + applyData(data) function.
const RENDER_LIFECYCLE_JS = `
  function announceReady() {
    window.parent.postMessage({ type: 'ui-lifecycle-iframe-ready' }, '*');
  }

  // Report content size to the host so the iframe doesn't get scrollbars.
  // The mcpApps adapter translates ui-size-change → ui/notifications/size-changed.
  let lastReported = { w: 0, h: 0 };
  function reportSize() {
    const h = Math.max(
      document.body ? document.body.scrollHeight : 0,
      document.documentElement ? document.documentElement.scrollHeight : 0,
    );
    const w = Math.max(
      document.body ? document.body.scrollWidth : 0,
      document.documentElement ? document.documentElement.scrollWidth : 0,
    );
    if (w === lastReported.w && h === lastReported.h) return;
    lastReported = { w, h };
    window.parent.postMessage({ type: 'ui-size-change', payload: { width: w, height: h } }, '*');
  }
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => reportSize());
    if (document.body) ro.observe(document.body);
    if (document.documentElement) ro.observe(document.documentElement);
  }

  let receivedData = false;
  window.addEventListener('message', (event) => {
    const d = event.data;
    if (!d || !d.type) return;
    if (d.type !== 'ui-lifecycle-iframe-render-data') return;
    const out = d.payload && d.payload.renderData && d.payload.renderData.toolOutput;
    if (!out || !out.content || !out.content[0] || !out.content[0].text) return;
    try {
      applyData(JSON.parse(out.content[0].text));
      receivedData = true;
      // applyData populated the DOM; report new size on the next frame.
      requestAnimationFrame(reportSize);
    } catch (err) {
      console.error('parse error', err);
    }
  });

  // Send ready and an initial size report (before data arrives).
  announceReady();
  requestAnimationFrame(reportSize);
`;

const RESTAURANT_CARD_TEMPLATE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f7f7f7; padding: 20px; }
  .card { max-width: 360px; margin: 0 auto; background: white; border-radius: 16px; overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,0.1); }
  .hero { height: 140px; display: flex; align-items: center; justify-content: center; font-size: 56px; background: #ddd; }
  .body { padding: 16px 18px 20px; }
  .name { font-size: 20px; font-weight: 700; color: #1f1f1f; margin: 0 0 4px 0; }
  .cuisine { color: #777; font-size: 14px; margin: 0 0 14px 0; }
  .meta { display: flex; gap: 8px; flex-wrap: wrap; }
  .pill { padding: 5px 11px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .rating { background: #e8f7ee; color: #2e7d32; }
  .eta { background: #fff4e5; color: #b76f00; }
  .price { background: #f0f0ff; color: #4339a8; }
  .skeleton .name, .skeleton .cuisine, .skeleton .meta { opacity: 0.3; }
</style></head><body>
  <div class="card skeleton" id="card">
    <div class="hero" id="hero">⏳</div>
    <div class="body">
      <h1 class="name" id="name">Loading…</h1>
      <p class="cuisine" id="cuisine">&nbsp;</p>
      <div class="meta" id="meta"></div>
    </div>
  </div>
<script>
  function applyData(data) {
    const r = data.restaurant;
    if (!r) return;
    const hero = document.getElementById('hero');
    hero.textContent = (r.items && r.items[0] && r.items[0].emoji) || '🍽';
    hero.style.background = 'linear-gradient(135deg, ' + r.gradient[0] + ' 0%, ' + r.gradient[1] + ' 100%)';
    document.getElementById('name').textContent = r.name;
    document.getElementById('cuisine').textContent = r.cuisine + ' cuisine';
    document.getElementById('meta').innerHTML =
      '<span class="pill rating">★ ' + r.rating + '</span>' +
      '<span class="pill eta">⏱ ' + r.etaMin + ' min</span>' +
      '<span class="pill price">' + r.priceRange + '</span>';
    document.getElementById('card').classList.remove('skeleton');
  }
${RENDER_LIFECYCLE_JS}
</script>
</body></html>`;

const ORDER_FORM_TEMPLATE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f7f7f7; padding: 20px; }
  .form { max-width: 360px; margin: 0 auto; background: white; border-radius: 16px; padding: 20px; box-shadow: 0 8px 24px rgba(0,0,0,0.1); }
  h1 { margin: 0 0 4px 0; font-size: 18px; }
  .sub { color: #777; font-size: 13px; margin: 0 0 14px 0; }
  .item { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid #eee; cursor: pointer; }
  .item input { margin: 0; }
  .item .label { flex: 1; font-size: 14px; }
  .item .price { color: #555; font-weight: 600; font-size: 13px; }
  .total { margin: 16px 0 12px; font-weight: 700; font-size: 16px; display: flex; justify-content: space-between; }
  button { width: 100%; padding: 12px; background: #fc8019; color: white; border: 0; border-radius: 10px; font-weight: 700; font-size: 15px; cursor: pointer; }
  button:hover { background: #e06d10; }
  button:disabled { background: #ccc; cursor: not-allowed; }
  .ack { background: #e8f7ee; color: #2e7d32; padding: 10px 12px; border-radius: 8px; margin-top: 12px; font-size: 13px; display: none; }
  .ack.show { display: block; }
  .ack.error { background: #fdecea; color: #b71c1c; }
  .skeleton .item, .skeleton h1 { opacity: 0.3; }
</style></head><body>
  <div class="form skeleton" id="form">
    <h1 id="rname">Loading…</h1>
    <p class="sub">Pick items, then add to cart:</p>
    <div id="items"></div>
    <div class="total">Total: <span id="total">$0.00</span></div>
    <button id="submit" disabled>Add to Cart</button>
    <div class="ack" id="ack"></div>
  </div>
<script>
  let RID = null;
  function escapeAttr(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  function applyData(data) {
    const r = data.restaurant;
    if (!r) return;
    RID = r.id;
    document.getElementById('rname').textContent = r.name;
    const items = document.getElementById('items');
    items.innerHTML = '';
    for (const it of r.items) {
      const lab = document.createElement('label');
      lab.className = 'item';
      lab.innerHTML = '<input type="checkbox" name="item" value="' + escapeAttr(it.name) +
        '" data-price="' + it.price + '" data-emoji="' + escapeAttr(it.emoji) + '">' +
        '<span class="label">' + it.emoji + ' ' + it.name + '</span>' +
        '<span class="price">$' + it.price.toFixed(2) + '</span>';
      items.appendChild(lab);
    }
    items.querySelectorAll('input[name="item"]').forEach(i => i.addEventListener('change', recalc));
    document.getElementById('form').classList.remove('skeleton');
  }

  function recalc() {
    let total = 0, count = 0;
    document.querySelectorAll('input[name="item"]').forEach(i => { if (i.checked) { total += parseFloat(i.dataset.price); count++; } });
    document.getElementById('total').textContent = '$' + total.toFixed(2);
    document.getElementById('submit').disabled = count === 0;
  }

  // Pattern B via the MCP Apps adapter: send {type:'tool', messageId, payload:{toolName, params}}
  // and await ui-message-response. With adapters.mcpApps.enabled = true on the server's
  // UI resource, the auto-injected adapter script bridges this to a real MCP tool call.
  function callServerTool(toolName, params) {
    return new Promise((resolve, reject) => {
      const messageId = 'tool-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const timer = setTimeout(() => {
        window.removeEventListener('message', handler);
        reject(new Error('host did not respond within 5s — Pattern B bridge unavailable'));
      }, 5000);
      function handler(event) {
        const d = event.data;
        if (!d || d.messageId !== messageId) return;
        if (d.type === 'ui-message-received') return; // ack only, ignore
        if (d.type !== 'ui-message-response') return;
        clearTimeout(timer);
        window.removeEventListener('message', handler);
        if (d.payload && d.payload.error) reject(d.payload.error);
        else resolve(d.payload && d.payload.response);
      }
      window.addEventListener('message', handler);
      window.parent.postMessage({ type: 'tool', messageId, payload: { toolName, params } }, '*');
    });
  }

  function fallbackPatternA(items, total) {
    const list = items.map(it => it.name + ' ($' + it.price.toFixed(2) + ')').join(', ');
    const prompt = 'Please call add_to_cart with restaurantId=' + RID +
      ' and items=' + JSON.stringify(items) + '. (Items: ' + list + '. Total: $' + total.toFixed(2) + '.)';
    window.parent.postMessage({ type: 'intent', payload: { intent: 'prompt', params: { prompt } } }, '*');
    window.parent.postMessage({ type: 'prompt', payload: { prompt } }, '*');
  }

  document.getElementById('submit').addEventListener('click', async () => {
    const all = [...document.querySelectorAll('input[name="item"]')];
    const selected = all.filter(i => i.checked).map(i => ({
      name: i.value, price: parseFloat(i.dataset.price), emoji: i.dataset.emoji,
    }));
    const total = selected.reduce((s, it) => s + it.price, 0);

    const submitEl = document.getElementById('submit');
    const ackEl = document.getElementById('ack');
    submitEl.disabled = true;
    submitEl.textContent = 'Adding…';
    ackEl.classList.remove('show', 'error');

    try {
      const result = await callServerTool('add_to_cart', { restaurantId: RID, items: selected });
      const text = (result && result.content && result.content[0] && result.content[0].text) || 'Items added.';
      ackEl.textContent = '✓ Pattern B: ' + text;
      ackEl.classList.add('show');
      submitEl.textContent = 'Added to Cart ✓';
    } catch (_err) {
      fallbackPatternA(selected, total);
      ackEl.textContent = '↩ Pattern A fallback: asked the assistant to add these items. Watch the chat.';
      ackEl.classList.add('show');
      submitEl.textContent = 'Sent to Assistant ✓';
    }
  });
${RENDER_LIFECYCLE_JS}
</script>
</body></html>`;

const CART_TEMPLATE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f7f7f7; padding: 20px; }
  .cart { max-width: 400px; margin: 0 auto; background: white; border-radius: 16px; padding: 20px; box-shadow: 0 8px 24px rgba(0,0,0,0.1); }
  .empty { text-align: center; color: #777; padding: 32px 0; }
  .empty .icon { font-size: 48px; margin-bottom: 12px; }
  h1 { margin: 0 0 16px 0; font-size: 20px; }
  section { margin-bottom: 18px; padding-bottom: 14px; border-bottom: 1px solid #eee; }
  section:last-of-type { border-bottom: none; }
  section h2 { margin: 0 0 10px 0; font-size: 15px; color: #444; }
  section h2 .sub { color: #999; font-weight: 400; font-size: 13px; }
  .row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 14px; }
  .row.subtotal { font-weight: 600; color: #555; padding-top: 10px; border-top: 1px dashed #eee; margin-top: 6px; }
  .rprice { color: #555; font-weight: 500; }
  .grand { margin-top: 16px; padding-top: 14px; border-top: 2px solid #1f1f1f; display: flex; justify-content: space-between; font-weight: 700; font-size: 17px; }
  .meta { color: #777; font-size: 13px; margin: 0 0 14px 0; }
</style></head><body>
  <div class="cart" id="cart">
    <h1>🛒 Your Cart</h1>
    <p class="meta" id="meta">Loading…</p>
    <div id="sections"></div>
    <div class="grand" id="grand" style="display:none"><span>Total</span><span id="grandValue">$0.00</span></div>
  </div>
<script>
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  function applyData(data) {
    const cart = data.cart || [];
    const restaurants = data.restaurants || {};
    const sectionsEl = document.getElementById('sections');
    const grandEl = document.getElementById('grand');
    const metaEl = document.getElementById('meta');

    if (cart.length === 0) {
      sectionsEl.innerHTML = '<div class="empty"><div class="icon">🛒</div><div>Your cart is empty</div><p>Add items via the order form, then come back here.</p></div>';
      grandEl.style.display = 'none';
      metaEl.style.display = 'none';
      return;
    }

    const byRest = {};
    for (const line of cart) (byRest[line.restaurantId] = byRest[line.restaurantId] || []).push(line);
    const restCount = Object.keys(byRest).length;
    metaEl.textContent = cart.length + ' item' + (cart.length === 1 ? '' : 's') + ' from ' +
      restCount + ' restaurant' + (restCount === 1 ? '' : 's');

    let html = '';
    for (const [rid, lines] of Object.entries(byRest)) {
      const r = restaurants[rid] || { name: rid, cuisine: '' };
      let rows = '';
      let subtotal = 0;
      for (const l of lines) {
        rows += '<div class="row"><span>' + (l.emoji || '🍴') + ' ' + escapeHtml(l.name) +
          '</span><span class="rprice">$' + l.price.toFixed(2) + '</span></div>';
        subtotal += l.price;
      }
      html += '<section><h2>' + escapeHtml(r.name) +
        ' <span class="sub">(' + escapeHtml(r.cuisine) + ')</span></h2>' + rows +
        '<div class="row subtotal"><span>Subtotal</span><span>$' + subtotal.toFixed(2) + '</span></div></section>';
    }
    sectionsEl.innerHTML = html;
    const total = cart.reduce((s, l) => s + l.price, 0);
    document.getElementById('grandValue').textContent = '$' + total.toFixed(2);
    grandEl.style.display = '';
  }
${RENDER_LIFECYCLE_JS}
</script>
</body></html>`;

// ───────────────────────────────────────────────────────────────────────────
// Legacy helper for show_menu_page (externalUrl, no bridge needed).
// ───────────────────────────────────────────────────────────────────────────

type LegacyUIResource = {
  type: 'resource';
  resource: {
    uri: `ui://${string}`;
    mimeType: 'text/uri-list';
    text: string;
    _meta?: Record<string, unknown>;
  };
};

function externalUrlResource(uri: `ui://${string}`, iframeUrl: string, framePx?: [string, string]): LegacyUIResource {
  return {
    type: 'resource',
    resource: {
      uri,
      mimeType: 'text/uri-list',
      text: iframeUrl,
      ...(framePx ? { _meta: { 'mcpui.dev/ui-preferred-frame-size': framePx } } : {}),
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// MCP server factory.
// ───────────────────────────────────────────────────────────────────────────

const restaurantIdSchema = z
  .enum(['r1', 'r2', 'r3'])
  .describe('Restaurant ID. r1=Pizza Paradiso, r2=Sushi Zen, r3=Curry House');

async function buildServer(): Promise<McpServer> {
  const server = new McpServer({ name: 'mcp-ui-demo', version: '0.3.0' });
  const cart: CartLine[] = [];

  // Register UI resources (fixed templates) with the MCP Apps adapter enabled.
  // The adapter script auto-injected by the SDK bridges {type:'tool',...} postMessages
  // from the iframe directly to MCP tool calls — no LLM round-trip.

  const cardUI = await createUIResource({
    uri: 'ui://mcp-ui-demo/template/restaurant-card',
    content: { type: 'rawHtml', htmlString: RESTAURANT_CARD_TEMPLATE },
    encoding: 'text',
    uiMetadata: { 'preferred-frame-size': ['400px', '320px'] },
    adapters: { mcpApps: { enabled: true } },
  });

  const orderFormUI = await createUIResource({
    uri: 'ui://mcp-ui-demo/template/order-form',
    content: { type: 'rawHtml', htmlString: ORDER_FORM_TEMPLATE },
    encoding: 'text',
    uiMetadata: { 'preferred-frame-size': ['400px', '500px'] },
    adapters: { mcpApps: { enabled: true } },
  });

  const cartUI = await createUIResource({
    uri: 'ui://mcp-ui-demo/template/cart',
    content: { type: 'rawHtml', htmlString: CART_TEMPLATE },
    encoding: 'text',
    uiMetadata: { 'preferred-frame-size': ['440px', '500px'] },
    adapters: { mcpApps: { enabled: true } },
  });

  registerAppResource(server, 'restaurant_card_ui', cardUI.resource.uri, {}, async () => ({
    contents: [cardUI.resource],
  }));
  registerAppResource(server, 'order_form_ui', orderFormUI.resource.uri, {}, async () => ({
    contents: [orderFormUI.resource],
  }));
  registerAppResource(server, 'cart_ui', cartUI.resource.uri, {}, async () => ({
    contents: [cartUI.resource],
  }));

  // ── UI tools (App-registered) ──

  registerAppTool(
    server,
    'show_restaurant_card',
    {
      description:
        'Show a styled restaurant card in an interactive widget. Returns restaurant data; the linked UI template renders it.',
      inputSchema: { restaurantId: restaurantIdSchema },
      _meta: { ui: { resourceUri: cardUI.resource.uri } },
    },
    async ({ restaurantId }) => {
      const r = restaurants[restaurantId];
      return {
        content: [{ type: 'text', text: JSON.stringify({ restaurant: r }) }],
      };
    },
  );

  registerAppTool(
    server,
    'show_order_form',
    {
      description:
        'Show an interactive order form for a restaurant. Submitting calls add_to_cart DIRECTLY via the MCP Apps bridge — no LLM round-trip (Pattern B).',
      inputSchema: { restaurantId: restaurantIdSchema },
      _meta: { ui: { resourceUri: orderFormUI.resource.uri } },
    },
    async ({ restaurantId }) => {
      const r = restaurants[restaurantId];
      return {
        content: [{ type: 'text', text: JSON.stringify({ restaurant: r }) }],
      };
    },
  );

  registerAppTool(
    server,
    'view_cart',
    {
      description:
        'Show the current shopping cart as a styled UI. Cart state is shared across all tools in this session.',
      inputSchema: {},
      _meta: { ui: { resourceUri: cartUI.resource.uri } },
    },
    async () => {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ cart, restaurants }),
          },
        ],
      };
    },
  );

  // ── Legacy externalUrl (no bridge needed) ──

  server.registerTool(
    'show_menu_page',
    {
      title: 'Show Menu Page',
      description:
        "Embeds the cuisine's Wikipedia page in an iframe (externalUrl mode). No bridge needed — host just loads the URL.",
      inputSchema: { restaurantId: restaurantIdSchema },
    },
    async ({ restaurantId }) => {
      const r = restaurants[restaurantId];
      const ui = externalUrlResource(
        `ui://mcp-ui-demo/menu/${r.id}`,
        r.cuisineWikiUrl,
        ['100%', '600px'],
      );
      return { content: [ui] };
    },
  );

  // ── Non-UI tools (called from iframes via Pattern B, or directly by Claude) ──

  server.registerTool(
    'add_to_cart',
    {
      title: 'Add to Cart',
      description:
        'Append items to the session cart. Called directly from the order-form iframe via the MCP Apps adapter (no LLM in the loop).',
      inputSchema: {
        restaurantId: restaurantIdSchema,
        items: z
          .array(
            z.object({
              name: z.string(),
              price: z.number(),
              emoji: z.string().optional(),
            }),
          )
          .min(1)
          .describe('Items to add to the cart'),
      },
    },
    async ({ restaurantId, items }) => {
      for (const it of items) {
        cart.push({ restaurantId, name: it.name, price: it.price, emoji: it.emoji ?? '🍴' });
      }
      const total = cart.reduce((s, l) => s + l.price, 0);
      const r = restaurants[restaurantId];
      return {
        content: [
          {
            type: 'text',
            text: `Added ${items.length} item${items.length === 1 ? '' : 's'} from ${r.name}. Cart now has ${cart.length} item${cart.length === 1 ? '' : 's'}, total $${total.toFixed(2)}.`,
          },
        ],
      };
    },
  );

  server.registerTool(
    'clear_cart',
    {
      title: 'Clear Cart',
      description: 'Empty the session cart.',
      inputSchema: {},
    },
    async () => {
      const n = cart.length;
      cart.length = 0;
      return {
        content: [
          { type: 'text', text: `Cleared ${n} item${n === 1 ? '' : 's'} from the cart.` },
        ],
      };
    },
  );

  return server;
}

// ───────────────────────────────────────────────────────────────────────────
// Transport bootstrap.
// ───────────────────────────────────────────────────────────────────────────

async function startStdio(): Promise<void> {
  const server = await buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('mcp-ui-demo: stdio transport ready');
}

function startHttp(): void {
  const app = express();
  const port = Number(process.env.PORT ?? 3000);

  app.use(
    cors({
      origin: '*',
      exposedHeaders: ['Mcp-Session-Id'],
      allowedHeaders: ['Content-Type', 'mcp-session-id'],
    }),
  );
  app.use(express.json());

  const transports: Record<string, StreamableHTTPServerTransport> = {};

  app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
          console.log(`mcp-ui-demo: session initialized ${sid}`);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          console.log(`mcp-ui-demo: session closed ${transport.sessionId}`);
          delete transports[transport.sessionId];
        }
      };
      const server = await buildServer();
      await server.connect(transport);
    } else {
      res
        .status(400)
        .json({ error: { message: 'Bad Request: No valid session ID provided' } });
      return;
    }
    await transport.handleRequest(req, res, req.body);
  });

  const handleSession = async (req: express.Request, res: express.Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(404).send('Session not found');
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  };
  app.get('/mcp', handleSession);
  app.delete('/mcp', handleSession);

  app.listen(port, () => {
    console.log(`mcp-ui-demo: listening at http://localhost:${port}/mcp`);
  });
}

const transport = process.env.MCP_TRANSPORT ?? 'http';
if (transport === 'stdio') {
  startStdio().catch((err) => {
    console.error('mcp-ui-demo: stdio startup failed', err);
    process.exit(1);
  });
} else {
  startHttp();
}
