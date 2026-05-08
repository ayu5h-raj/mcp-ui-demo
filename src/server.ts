import express from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

// We deliberately avoid @mcp-ui/server's createUIResource here because v6 hard-codes
// mimeType to 'text/html;profile=mcp-app', which Claude Desktop treats as data unless
// it's registered as a proper MCP App via registerAppTool/registerAppResource. For a
// minimal demo we hand-roll the UIResource with the legacy 'text/html' mime — Claude
// Desktop and ui-inspector both render it as an iframe out of the box.
type UIResource = {
  type: 'resource';
  resource: {
    uri: `ui://${string}`;
    mimeType: 'text/html' | 'text/uri-list';
    text: string;
    _meta?: Record<string, unknown>;
  };
};

function rawHtmlResource(uri: `ui://${string}`, htmlString: string, framePx?: [string, string]): UIResource {
  return {
    type: 'resource',
    resource: {
      uri,
      mimeType: 'text/html',
      text: htmlString,
      ...(framePx
        ? { _meta: { 'mcpui.dev/ui-preferred-frame-size': framePx } }
        : {}),
    },
  };
}

function externalUrlResource(uri: `ui://${string}`, iframeUrl: string, framePx?: [string, string]): UIResource {
  return {
    type: 'resource',
    resource: {
      uri,
      mimeType: 'text/uri-list',
      text: iframeUrl,
      ...(framePx
        ? { _meta: { 'mcpui.dev/ui-preferred-frame-size': framePx } }
        : {}),
    },
  };
}

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
// HTML builders
// ───────────────────────────────────────────────────────────────────────────

function buildRestaurantCardHTML(r: Restaurant): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f7f7f7; padding: 20px; }
  .card { max-width: 360px; margin: 0 auto; background: white; border-radius: 16px; overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,0.1); }
  .hero { height: 140px; background: linear-gradient(135deg, ${r.gradient[0]} 0%, ${r.gradient[1]} 100%); display: flex; align-items: center; justify-content: center; font-size: 56px; }
  .body { padding: 16px 18px 20px; }
  .name { font-size: 20px; font-weight: 700; color: #1f1f1f; margin: 0 0 4px 0; }
  .cuisine { color: #777; font-size: 14px; margin: 0 0 14px 0; }
  .meta { display: flex; gap: 8px; flex-wrap: wrap; }
  .pill { padding: 5px 11px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .rating { background: #e8f7ee; color: #2e7d32; }
  .eta { background: #fff4e5; color: #b76f00; }
  .price { background: #f0f0ff; color: #4339a8; }
</style></head><body>
  <div class="card">
    <div class="hero">${r.items[0].emoji}</div>
    <div class="body">
      <h1 class="name">${escapeHtml(r.name)}</h1>
      <p class="cuisine">${escapeHtml(r.cuisine)} cuisine</p>
      <div class="meta">
        <span class="pill rating">★ ${r.rating}</span>
        <span class="pill eta">⏱ ${r.etaMin} min</span>
        <span class="pill price">${r.priceRange}</span>
      </div>
    </div>
  </div>
</body></html>`;
}

function buildOrderFormHTML(r: Restaurant): string {
  const itemRows = r.items
    .map(
      (it) => `<label class="item">
      <input type="checkbox" name="item" value="${escapeAttr(it.name)}" data-price="${it.price}" data-emoji="${escapeAttr(it.emoji)}">
      <span class="label">${it.emoji} ${escapeHtml(it.name)}</span>
      <span class="price">$${it.price.toFixed(2)}</span>
    </label>`,
    )
    .join('\n');

  return `<!doctype html>
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
</style></head><body>
  <div class="form">
    <h1>${escapeHtml(r.name)}</h1>
    <p class="sub">Pick items, then add to cart:</p>
    <div id="items">${itemRows}</div>
    <div class="total">Total: <span id="total">$0.00</span></div>
    <button id="submit" disabled>Add to Cart</button>
    <div class="ack" id="ack"></div>
  </div>
<script>
  const items = document.querySelectorAll('input[name="item"]');
  const totalEl = document.getElementById('total');
  const ackEl = document.getElementById('ack');
  const submitEl = document.getElementById('submit');
  const RESTAURANT_ID = ${JSON.stringify(r.id)};

  function recalc() {
    let total = 0, count = 0;
    items.forEach((i) => { if (i.checked) { total += parseFloat(i.dataset.price); count++; } });
    totalEl.textContent = '$' + total.toFixed(2);
    submitEl.disabled = count === 0;
  }
  items.forEach((i) => i.addEventListener('change', recalc));

  // Try Pattern B first (direct tool call via MCP Apps bridge). If the host
  // doesn't respond within the timeout, fall back to Pattern A (prompt intent
  // → host forwards as a follow-up user turn → Claude calls add_to_cart).
  function tryPatternB(toolName, params) {
    return new Promise((resolve, reject) => {
      const messageId = 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const timer = setTimeout(() => {
        window.removeEventListener('message', handler);
        reject(new Error('Pattern B timeout (host did not route tool message)'));
      }, 2000);
      function handler(event) {
        const data = event.data;
        if (!data || data.messageId !== messageId) return;
        if (data.type !== 'ui-message-response') return;
        clearTimeout(timer);
        window.removeEventListener('message', handler);
        if (data.payload && data.payload.error) reject(data.payload.error);
        else resolve(data.payload && data.payload.response);
      }
      window.addEventListener('message', handler);
      window.parent.postMessage({ type: 'tool', messageId, payload: { toolName, params } }, '*');
    });
  }

  function fallbackPatternA(restaurantId, restaurantName, items, total) {
    const list = items.map((it) => it.name + ' ($' + it.price.toFixed(2) + ')').join(', ');
    const prompt = 'Please add these items to my cart by calling the add_to_cart tool with restaurantId=' +
      restaurantId + ' and items=' + JSON.stringify(items) +
      '. Items: ' + list + '. Total: $' + total.toFixed(2) + ' from ' + restaurantName + '.';
    window.parent.postMessage({ type: 'intent', payload: { intent: 'prompt', params: { prompt } } }, '*');
    // Also fire a 'prompt'-typed message in case the host uses the alt format
    window.parent.postMessage({ type: 'prompt', payload: { prompt } }, '*');
  }

  submitEl.addEventListener('click', async () => {
    const selected = [...items]
      .filter((i) => i.checked)
      .map((i) => ({ name: i.value, price: parseFloat(i.dataset.price), emoji: i.dataset.emoji }));
    const total = selected.reduce((s, it) => s + it.price, 0);

    submitEl.disabled = true;
    submitEl.textContent = 'Adding…';
    ackEl.classList.remove('show', 'error');

    try {
      const result = await tryPatternB('add_to_cart', { restaurantId: RESTAURANT_ID, items: selected });
      const text = (result && result.content && result.content[0] && result.content[0].text) || 'Items added (Pattern B — direct tool call).';
      ackEl.textContent = '✓ Pattern B: ' + text;
      ackEl.classList.add('show');
      submitEl.textContent = 'Added to Cart ✓';
    } catch (_err) {
      // Host doesn't bridge 'tool' messages in this UIResource format. Fall back.
      fallbackPatternA(RESTAURANT_ID, ${JSON.stringify(r.name)}, selected, total);
      ackEl.textContent = '↩ Pattern A fallback: asked the assistant to add these items. Watch the chat — Claude should call add_to_cart shortly.';
      ackEl.classList.add('show');
      submitEl.textContent = 'Sent to Assistant ✓';
    }
  });
</script>
</body></html>`;
}

function buildCartHTML(cart: CartLine[]): string {
  if (cart.length === 0) {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f7f7f7; padding: 20px; }
  .empty { max-width: 360px; margin: 40px auto; background: white; border-radius: 16px; padding: 32px; text-align: center; box-shadow: 0 8px 24px rgba(0,0,0,0.08); color: #777; }
  .empty .icon { font-size: 48px; margin-bottom: 12px; }
  .empty h1 { margin: 0 0 6px 0; font-size: 18px; color: #1f1f1f; }
</style></head><body>
  <div class="empty"><div class="icon">🛒</div><h1>Your cart is empty</h1><p>Add items via the order form, then come back here.</p></div>
</body></html>`;
  }

  // Group by restaurant
  const byRest: Record<string, CartLine[]> = {};
  for (const line of cart) (byRest[line.restaurantId] ??= []).push(line);

  const sections = Object.entries(byRest)
    .map(([rid, lines]) => {
      const r = restaurants[rid as Restaurant['id']];
      const rows = lines
        .map(
          (l) =>
            `<div class="row"><span>${l.emoji} ${escapeHtml(l.name)}</span><span class="rprice">$${l.price.toFixed(2)}</span></div>`,
        )
        .join('\n');
      const subtotal = lines.reduce((s, l) => s + l.price, 0);
      return `<section><h2>${escapeHtml(r.name)} <span class="sub">(${escapeHtml(r.cuisine)})</span></h2>${rows}<div class="row subtotal"><span>Subtotal</span><span>$${subtotal.toFixed(2)}</span></div></section>`;
    })
    .join('\n');

  const grandTotal = cart.reduce((s, l) => s + l.price, 0);
  const itemCount = cart.length;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f7f7f7; padding: 20px; }
  .cart { max-width: 400px; margin: 0 auto; background: white; border-radius: 16px; padding: 20px; box-shadow: 0 8px 24px rgba(0,0,0,0.1); }
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
  <div class="cart">
    <h1>🛒 Your Cart</h1>
    <p class="meta">${itemCount} item${itemCount === 1 ? '' : 's'} from ${Object.keys(byRest).length} restaurant${Object.keys(byRest).length === 1 ? '' : 's'}</p>
    ${sections}
    <div class="grand"><span>Total</span><span>$${grandTotal.toFixed(2)}</span></div>
  </div>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!),
  );
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}

// ───────────────────────────────────────────────────────────────────────────
// MCP server factory — registers all tools.
// Cart state is per-server-instance (per-session for HTTP, process-lifetime for stdio).
// ───────────────────────────────────────────────────────────────────────────

const restaurantIdSchema = z
  .enum(['r1', 'r2', 'r3'])
  .describe('Restaurant ID. r1=Pizza Paradiso, r2=Sushi Zen, r3=Curry House');

function buildServer(): McpServer {
  const server = new McpServer({ name: 'mcp-ui-demo', version: '0.2.0' });
  const cart: CartLine[] = [];

  // ── UI tools (return UIResource with mcpApps adapter for direct tool-call back) ──

  server.registerTool(
    'show_restaurant_card',
    {
      title: 'Show Restaurant Card',
      description:
        'Returns a styled UI card for a restaurant (rawHtml mode). Demonstrates rich, inline-styled HTML rendered in a sandboxed iframe.',
      inputSchema: { restaurantId: restaurantIdSchema },
    },
    async ({ restaurantId }) => {
      const r = restaurants[restaurantId];
      const ui = rawHtmlResource(
        `ui://mcp-ui-demo/restaurant/${r.id}`,
        buildRestaurantCardHTML(r),
        ['400px', '320px'],
      );
      return { content: [ui] };
    },
  );

  server.registerTool(
    'show_menu_page',
    {
      title: 'Show Menu Page',
      description:
        "Embeds the cuisine's Wikipedia page in an iframe (externalUrl mode). Demonstrates handing the host any third-party URL.",
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

  server.registerTool(
    'show_order_form',
    {
      title: 'Show Order Form',
      description:
        'Returns an interactive order form. Submit tries Pattern B (direct tool call to add_to_cart via MCP Apps bridge) first, falling back to Pattern A (prompt intent → Claude calls add_to_cart) if the bridge is unavailable.',
      inputSchema: { restaurantId: restaurantIdSchema },
    },
    async ({ restaurantId }) => {
      const r = restaurants[restaurantId];
      const ui = rawHtmlResource(
        `ui://mcp-ui-demo/order-form/${r.id}`,
        buildOrderFormHTML(r),
        ['400px', '500px'],
      );
      return { content: [ui] };
    },
  );

  server.registerTool(
    'view_cart',
    {
      title: 'View Cart',
      description:
        'Show the current shopping cart as a styled UI. Cart state is shared across all tools in this session.',
      inputSchema: {},
    },
    async () => {
      const ui = rawHtmlResource('ui://mcp-ui-demo/cart', buildCartHTML(cart), ['440px', '500px']);
      return { content: [ui] };
    },
  );

  // ── Non-UI tools (called from iframes via Pattern B) ──

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
// Transport bootstrap — branches on MCP_TRANSPORT env var.
// ───────────────────────────────────────────────────────────────────────────

async function startStdio(): Promise<void> {
  const server = buildServer();
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
      const server = buildServer();
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
