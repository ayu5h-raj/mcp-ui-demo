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
// Tic-tac-toe vs Claude — the human plays X, Claude plays O.
// Human's moves come from the iframe (Pattern B). Claude's moves come from
// the LLM seeing a `prompt` intent that the iframe posts after the human's
// move (Pattern A). Both sides call the same `make_move` tool — the server
// picks the player from `game.turn`.
// ───────────────────────────────────────────────────────────────────────────

type Cell = 'X' | 'O' | null;
type Player = 'X' | 'O';
type GameState = {
  board: Cell[][]; // 3x3, board[row][col]
  turn: Player; // whose turn next (game over → frozen)
  winner: Player | 'draw' | null;
  moveCount: number;
  history: { player: Player; row: number; col: number }[];
};

function newGame(): GameState {
  return {
    board: [
      [null, null, null],
      [null, null, null],
      [null, null, null],
    ],
    turn: 'X',
    winner: null,
    moveCount: 0,
    history: [],
  };
}

const WIN_LINES: [number, number][][] = [
  // rows
  [[0, 0], [0, 1], [0, 2]],
  [[1, 0], [1, 1], [1, 2]],
  [[2, 0], [2, 1], [2, 2]],
  // cols
  [[0, 0], [1, 0], [2, 0]],
  [[0, 1], [1, 1], [2, 1]],
  [[0, 2], [1, 2], [2, 2]],
  // diagonals
  [[0, 0], [1, 1], [2, 2]],
  [[0, 2], [1, 1], [2, 0]],
];

function checkWinner(board: Cell[][]): Player | 'draw' | null {
  for (const line of WIN_LINES) {
    const [a, b, c] = line;
    const v = board[a[0]][a[1]];
    if (v && v === board[b[0]][b[1]] && v === board[c[0]][c[1]]) return v;
  }
  const full = board.every((row) => row.every((c) => c !== null));
  return full ? 'draw' : null;
}

// ───────────────────────────────────────────────────────────────────────────
// UI template — generic. Data flows in via ui-lifecycle-iframe-render-data.
// ───────────────────────────────────────────────────────────────────────────

const RENDER_LIFECYCLE_JS = `
  function announceReady() {
    window.parent.postMessage({ type: 'ui-lifecycle-iframe-ready' }, '*');
  }

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

  window.addEventListener('message', (event) => {
    const d = event.data;
    if (!d || !d.type) return;
    if (d.type !== 'ui-lifecycle-iframe-render-data') return;
    const out = d.payload && d.payload.renderData && d.payload.renderData.toolOutput;
    if (!out || !out.content || !out.content[0] || !out.content[0].text) return;
    try {
      applyData(JSON.parse(out.content[0].text));
      requestAnimationFrame(reportSize);
    } catch (err) {
      console.error('parse error', err);
    }
  });

  announceReady();
  requestAnimationFrame(reportSize);
`;

const GAME_TEMPLATE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f7; padding: 20px; }
  .game { max-width: 380px; margin: 0 auto; background: white; border-radius: 16px; padding: 22px; box-shadow: 0 8px 24px rgba(0,0,0,0.08); }
  h1 { margin: 0 0 4px 0; font-size: 18px; color: #1f1f1f; }
  .sub { color: #777; font-size: 13px; margin: 0 0 14px 0; }
  .status { padding: 10px 12px; border-radius: 10px; font-size: 14px; font-weight: 600; margin-bottom: 14px; text-align: center; }
  .status.your-turn { background: #e8f7ee; color: #2e7d32; }
  .status.thinking { background: #fff4e5; color: #b76f00; }
  .status.win { background: #e8f7ee; color: #2e7d32; font-size: 16px; }
  .status.lose { background: #fdecea; color: #b71c1c; font-size: 16px; }
  .status.draw { background: #eef0f3; color: #555; font-size: 16px; }
  .board { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; aspect-ratio: 1 / 1; margin: 0 auto; max-width: 320px; }
  .cell { aspect-ratio: 1; background: #f5f5f7; border: 0; border-radius: 10px; font-size: 48px; font-weight: 700; color: #1f1f1f; cursor: pointer; transition: background 0.15s; display: flex; align-items: center; justify-content: center; padding: 0; }
  .cell:hover:not(:disabled) { background: #e8e8ec; }
  .cell:disabled { cursor: default; }
  .cell.x { color: #1976d2; }
  .cell.o { color: #d32f2f; }
  .cell.win { background: #c8e6c9 !important; }
  .actions { margin-top: 16px; display: flex; gap: 8px; }
  .btn { flex: 1; padding: 11px; border: 0; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; }
  .btn.primary { background: #1f1f1f; color: white; }
  .btn.primary:hover { background: #333; }
  .btn.secondary { background: #eef0f3; color: #1f1f1f; }
  .btn.secondary:hover { background: #ddd; }
  .moves { margin-top: 12px; color: #777; font-size: 12px; text-align: center; }
  .skeleton .board, .skeleton .status { opacity: 0.3; }
</style></head><body>
  <div class="game skeleton" id="game">
    <h1>Tic-Tac-Toe vs Claude</h1>
    <p class="sub">You are <strong style="color:#1976d2">X</strong>. Claude is <strong style="color:#d32f2f">O</strong>.</p>
    <div class="status" id="status">Loading…</div>
    <div class="board" id="board"></div>
    <div class="actions">
      <button class="btn secondary" id="newGameBtn">New Game</button>
      <button class="btn primary" id="nudgeBtn" style="display:none">Nudge Claude</button>
    </div>
    <div class="moves" id="moves"></div>
  </div>
<script>
  // ── Pattern B helper ──
  function callServerTool(toolName, params, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const messageId = 'tool-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const timer = setTimeout(() => {
        window.removeEventListener('message', handler);
        reject(new Error('host did not respond within ' + timeoutMs + 'ms'));
      }, timeoutMs);
      function handler(event) {
        const d = event.data;
        if (!d || d.messageId !== messageId) return;
        if (d.type === 'ui-message-received') return;
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

  // ── State + render ──
  let state = null;
  let polling = false;

  function render() {
    const g = state;
    const boardEl = document.getElementById('board');
    const statusEl = document.getElementById('status');
    const movesEl = document.getElementById('moves');
    const nudgeBtn = document.getElementById('nudgeBtn');
    if (!g) return;
    document.getElementById('game').classList.remove('skeleton');

    // Status
    statusEl.classList.remove('your-turn', 'thinking', 'win', 'lose', 'draw');
    if (g.winner === 'X') { statusEl.textContent = '🎉 You won!'; statusEl.classList.add('win'); }
    else if (g.winner === 'O') { statusEl.textContent = '🤖 Claude won.'; statusEl.classList.add('lose'); }
    else if (g.winner === 'draw') { statusEl.textContent = '🤝 Draw.'; statusEl.classList.add('draw'); }
    else if (g.turn === 'X') { statusEl.textContent = 'Your turn (X)'; statusEl.classList.add('your-turn'); }
    else { statusEl.textContent = polling ? '🤖 Claude is thinking…' : '🤖 Claude\\'s turn (O)'; statusEl.classList.add('thinking'); }

    // Board
    boardEl.innerHTML = '';
    const winLine = winLineFor(g.board);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const v = g.board[r][c];
        const btn = document.createElement('button');
        btn.className = 'cell' + (v === 'X' ? ' x' : v === 'O' ? ' o' : '');
        if (winLine && winLine.some(([wr, wc]) => wr === r && wc === c)) btn.classList.add('win');
        btn.textContent = v || '';
        btn.disabled = !!v || g.winner !== null || g.turn !== 'X' || polling;
        btn.addEventListener('click', () => onCellClick(r, c));
        boardEl.appendChild(btn);
      }
    }

    // Move count
    movesEl.textContent = g.moveCount + ' move' + (g.moveCount === 1 ? '' : 's') + ' so far';

    // Nudge button visible only when waiting for Claude AND not actively polling
    nudgeBtn.style.display = (g.turn === 'O' && g.winner === null && !polling) ? '' : 'none';
  }

  function winLineFor(board) {
    const lines = [
      [[0,0],[0,1],[0,2]],[[1,0],[1,1],[1,2]],[[2,0],[2,1],[2,2]],
      [[0,0],[1,0],[2,0]],[[0,1],[1,1],[2,1]],[[0,2],[1,2],[2,2]],
      [[0,0],[1,1],[2,2]],[[0,2],[1,1],[2,0]],
    ];
    for (const line of lines) {
      const [a,b,c] = line;
      const v = board[a[0]][a[1]];
      if (v && v === board[b[0]][b[1]] && v === board[c[0]][c[1]]) return line;
    }
    return null;
  }

  function applyData(data) {
    if (data && data.game) state = data.game;
    render();
  }

  // ── Actions ──
  async function onCellClick(row, col) {
    if (!state || state.winner !== null || state.turn !== 'X') return;
    try {
      const result = await callServerTool('make_move', { row, col });
      const newState = parseGameFromResult(result);
      if (newState) state = newState;
      render();
      if (state.winner === null && state.turn === 'O') {
        promptClaude();
        startPolling();
      }
    } catch (err) {
      alert('Move failed: ' + (err && err.message ? err.message : err));
    }
  }

  function parseGameFromResult(result) {
    try {
      const text = result && result.content && result.content[0] && result.content[0].text;
      if (!text) return null;
      const parsed = JSON.parse(text);
      return parsed.game || null;
    } catch { return null; }
  }

  function promptClaude() {
    const boardStr = state.board.map(row => row.map(c => c || '.').join(' ')).join('\\n');
    const empties = [];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) if (!state.board[r][c]) empties.push('(' + r + ',' + c + ')');
    const prompt = "It's your turn in tic-tac-toe (you are O, opponent is X). Current board:\\n" +
      boardStr + "\\nEmpty cells: " + empties.join(', ') +
      ". Pick a strategic move and call the make_move tool with row and col (each 0-2). Block opponent wins; take the center or corners early.";
    window.parent.postMessage({ type: 'intent', payload: { intent: 'prompt', params: { prompt } } }, '*');
  }

  async function startPolling() {
    if (polling) return;
    polling = true;
    render();
    const start = Date.now();
    let delay = 700;
    while (polling && Date.now() - start < 45000) {
      await new Promise(r => setTimeout(r, delay));
      try {
        const res = await callServerTool('get_game_state', {});
        const newState = parseGameFromResult(res);
        if (newState) {
          state = newState;
          if (state.turn === 'X' || state.winner !== null) {
            polling = false;
            render();
            return;
          }
        }
      } catch { /* keep trying */ }
      delay = Math.min(Math.round(delay * 1.4), 3000);
    }
    polling = false;
    render();
  }

  document.getElementById('newGameBtn').addEventListener('click', async () => {
    try {
      polling = false;
      const result = await callServerTool('reset_game', {});
      const newState = parseGameFromResult(result);
      if (newState) { state = newState; render(); }
    } catch (err) { alert('Reset failed: ' + err); }
  });

  document.getElementById('nudgeBtn').addEventListener('click', () => {
    if (!state || state.turn !== 'O' || state.winner !== null) return;
    promptClaude();
    startPolling();
  });
${RENDER_LIFECYCLE_JS}
</script>
</body></html>`;

// ───────────────────────────────────────────────────────────────────────────
// MCP server factory.
// ───────────────────────────────────────────────────────────────────────────

const moveSchema = {
  row: z.number().int().min(0).max(2).describe('Row (0-2). 0=top, 2=bottom.'),
  col: z.number().int().min(0).max(2).describe('Column (0-2). 0=left, 2=right.'),
};

// Ask Claude (via MCP sampling) to pick the next O move. Returns null if
// sampling is unavailable / declined / produces an invalid response. Caller
// falls back to the prompt-intent path in the iframe.
async function sampleClaudeMove(
  server: McpServer,
  game: GameState,
): Promise<{ row: number; col: number } | null> {
  const boardStr = game.board.map((row) => row.map((c) => c || '.').join(' ')).join('\n');
  const empties: string[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) if (!game.board[r][c]) empties.push(`(${r},${c})`);

  try {
    const result = await server.server.createMessage({
      systemPrompt:
        'You are a tic-tac-toe AI playing as O. Reply with ONLY two digits separated by a comma — row,col (each 0-2). No other text.',
      maxTokens: 20,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Current board (X is human, O is you):
${boardStr}
Empty cells: ${empties.join(', ')}
Pick the strongest move. Block opponent wins; prefer center, then corners. Reply with row,col only.`,
          },
        },
      ],
    });

    const text = result.content && result.content.type === 'text' ? result.content.text : '';
    const m = text.match(/(\d)\s*[,\s]\s*(\d)/);
    if (!m) return null;
    const row = parseInt(m[1], 10);
    const col = parseInt(m[2], 10);
    if (row < 0 || row > 2 || col < 0 || col > 2) return null;
    if (game.board[row][col] !== null) return null;
    return { row, col };
  } catch (err) {
    // Host doesn't support sampling, declined, or some other error.
    console.error('sampling unavailable:', err instanceof Error ? err.message : err);
    return null;
  }
}

async function buildServer(): Promise<McpServer> {
  const server = new McpServer({ name: 'mcp-ui-demo-game', version: '0.1.0' });
  let game: GameState = newGame();

  // ── UI template ──
  const gameUI = await createUIResource({
    uri: 'ui://mcp-ui-demo-game/template/board',
    content: { type: 'rawHtml', htmlString: GAME_TEMPLATE },
    encoding: 'text',
    uiMetadata: { 'preferred-frame-size': ['440px', '600px'] },
    adapters: { mcpApps: { enabled: true } },
  });
  registerAppResource(server, 'game_board_ui', gameUI.resource.uri, {}, async () => ({
    contents: [gameUI.resource],
  }));

  // ── UI tool: render the board ──
  registerAppTool(
    server,
    'play_tic_tac_toe',
    {
      description:
        'Show the tic-tac-toe board. The user is X (goes first), you (Claude) are O. Use this when the user wants to play a game. The board UI handles human turns directly via Pattern B; you make moves by calling the make_move tool when prompted.',
      inputSchema: {},
      _meta: { ui: { resourceUri: gameUI.resource.uri } },
    },
    async () => ({
      content: [{ type: 'text', text: JSON.stringify({ game }) }],
    }),
  );

  // ── make_move (used by both human via Pattern B and by Claude as O) ──
  server.registerTool(
    'make_move',
    {
      title: 'Make a Move',
      description:
        'Place a mark on the tic-tac-toe board. The server picks the player based on whose turn it is — X (human) or O (Claude). When you (Claude) are prompted to play, call this with your chosen row and col.',
      inputSchema: moveSchema,
    },
    async ({ row, col }) => {
      if (game.winner !== null) {
        return { isError: true, content: [{ type: 'text', text: `Game is over: ${game.winner}. Call reset_game to start a new one.` }] };
      }
      if (game.board[row][col] !== null) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `Cell (${row},${col}) is already taken by ${game.board[row][col]}. Empty cells: ${listEmpty(game.board)}.`,
          }],
        };
      }
      const justPlayed = game.turn;
      game.board[row][col] = justPlayed;
      game.history.push({ player: justPlayed, row, col });
      game.moveCount++;
      const w = checkWinner(game.board);
      if (w) {
        game.winner = w;
      } else {
        game.turn = justPlayed === 'X' ? 'O' : 'X';
      }

      // If the human just played and it's now Claude's turn, try MCP sampling
      // to get Claude's move synchronously. On success, apply it within the
      // same response — iframe sees both moves at once, no polling needed.
      // On failure, leave turn=O so the iframe falls back to its prompt+poll path.
      if (justPlayed === 'X' && game.winner === null && game.turn === 'O') {
        const claudeMove = await sampleClaudeMove(server, game);
        if (claudeMove) {
          game.board[claudeMove.row][claudeMove.col] = 'O';
          game.history.push({ player: 'O', row: claudeMove.row, col: claudeMove.col });
          game.moveCount++;
          const w2 = checkWinner(game.board);
          if (w2) game.winner = w2;
          else game.turn = 'X';
        }
      }

      return { content: [{ type: 'text', text: JSON.stringify({ game }) }] };
    },
  );

  // ── get_game_state (iframe polls this; Claude can also use it) ──
  server.registerTool(
    'get_game_state',
    {
      title: 'Get Game State',
      description:
        'Return the current tic-tac-toe board state. Used by the iframe to poll for Claude\'s move. Claude can also call this to refresh its view.',
      inputSchema: {},
    },
    async () => ({ content: [{ type: 'text', text: JSON.stringify({ game }) }] }),
  );

  // ── reset_game ──
  server.registerTool(
    'reset_game',
    {
      title: 'Reset Game',
      description: 'Start a new tic-tac-toe game. Clears the board.',
      inputSchema: {},
    },
    async () => {
      game = newGame();
      return { content: [{ type: 'text', text: JSON.stringify({ game }) }] };
    },
  );

  return server;
}

function listEmpty(board: Cell[][]): string {
  const out: string[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) if (!board[r][c]) out.push(`(${r},${c})`);
  return out.join(', ');
}

// ───────────────────────────────────────────────────────────────────────────
// Transport bootstrap.
// ───────────────────────────────────────────────────────────────────────────

async function startStdio(): Promise<void> {
  const server = await buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('mcp-ui-demo-game: stdio transport ready');
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
          console.log(`mcp-ui-demo-game: session initialized ${sid}`);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          console.log(`mcp-ui-demo-game: session closed ${transport.sessionId}`);
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
    console.log(`mcp-ui-demo-game: listening at http://localhost:${port}/mcp`);
  });
}

const transport = process.env.MCP_TRANSPORT ?? 'http';
if (transport === 'stdio') {
  startStdio().catch((err) => {
    console.error('mcp-ui-demo-game: stdio startup failed', err);
    process.exit(1);
  });
} else {
  startHttp();
}
