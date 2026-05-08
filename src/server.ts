import express from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createUIResource } from '@mcp-ui/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

// ───────────────────────────────────────────────────────────────────────────
// Mock data — three restaurants, four items each. Edit to taste.
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
      <input type="checkbox" name="item" value="${escapeAttr(it.name)}" data-price="${it.price}">
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
</style></head><body>
  <div class="form">
    <h1>${escapeHtml(r.name)}</h1>
    <p class="sub">Pick items, then place your order:</p>
    <div id="items">${itemRows}</div>
    <div class="total">Total: <span id="total">$0.00</span></div>
    <button id="submit" disabled>Place Order</button>
    <div class="ack" id="ack">Order placed — intent posted to host. Check the host's message log.</div>
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

  submitEl.addEventListener('click', () => {
    const selected = [...items]
      .filter((i) => i.checked)
      .map((i) => ({ name: i.value, price: parseFloat(i.dataset.price) }));
    const total = selected.reduce((s, it) => s + it.price, 0);
    window.parent.postMessage({
      type: 'intent',
      payload: {
        intent: 'place-order',
        restaurantId: RESTAURANT_ID,
        items: selected,
        total: Number(total.toFixed(2)),
      },
    }, '*');
    ackEl.classList.add('show');
    submitEl.disabled = true;
    submitEl.textContent = 'Order Placed ✓';
  });
</script>
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
// MCP server factory — registers all three tools
// ───────────────────────────────────────────────────────────────────────────

const restaurantIdSchema = z
  .enum(['r1', 'r2', 'r3'])
  .describe('Restaurant ID. r1=Pizza Paradiso, r2=Sushi Zen, r3=Curry House');

function buildServer(): McpServer {
  const server = new McpServer({ name: 'mcp-ui-demo', version: '0.1.0' });

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
      const ui = await createUIResource({
        uri: `ui://mcp-ui-demo/restaurant/${r.id}`,
        content: { type: 'rawHtml', htmlString: buildRestaurantCardHTML(r) },
        encoding: 'text',
        uiMetadata: { 'preferred-frame-size': ['400px', '320px'] },
      });
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
      const ui = await createUIResource({
        uri: `ui://mcp-ui-demo/menu/${r.id}`,
        content: { type: 'externalUrl', iframeUrl: r.cuisineWikiUrl },
        encoding: 'text',
        uiMetadata: { 'preferred-frame-size': ['100%', '600px'] },
      });
      return { content: [ui] };
    },
  );

  server.registerTool(
    'show_order_form',
    {
      title: 'Show Order Form',
      description:
        'Returns an interactive order form (rawHtml + postMessage). Submitting posts an "intent" message back to the host — demonstrates guest→host bidirectional UI.',
      inputSchema: { restaurantId: restaurantIdSchema },
    },
    async ({ restaurantId }) => {
      const r = restaurants[restaurantId];
      const ui = await createUIResource({
        uri: `ui://mcp-ui-demo/order-form/${r.id}`,
        content: { type: 'rawHtml', htmlString: buildOrderFormHTML(r) },
        encoding: 'text',
        uiMetadata: { 'preferred-frame-size': ['400px', '500px'] },
      });
      return { content: [ui] };
    },
  );

  return server;
}

// ───────────────────────────────────────────────────────────────────────────
// Transport bootstrap — branches on MCP_TRANSPORT env var
// ───────────────────────────────────────────────────────────────────────────

async function startStdio(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is reserved for the MCP framing protocol
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
