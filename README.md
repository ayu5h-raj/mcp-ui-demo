# mcp-ui-demo (experiment-game branch)

> **You are on the `experiment-game` branch.** The food/Swiggy demo lives on `main`. This branch replaces it with **Tic-Tac-Toe vs. Claude** — a small playable game running entirely inside Claude Desktop, where Claude itself is your opponent.

## What it is

A single MCP server with four tools that, together, make Claude an actual player:

| Tool | Kind | Purpose |
|---|---|---|
| `play_tic_tac_toe` | UI tool | Render the game board (a fixed `_meta.ui.resourceUri` template). |
| `make_move(row, col)` | data | Place a mark. Server resolves player from `game.turn` — same tool for human (called from iframe via Pattern B) and Claude (called by the LLM after a `prompt` intent). |
| `get_game_state()` | data | Return current board state. The iframe polls this while waiting for Claude's move. |
| `reset_game()` | data | Start fresh. |

You play **X** (you go first). Claude plays **O**.

## How a turn works

```
You click a cell
  ─► iframe Pattern B: make_move(row, col)         server marks X, flips turn to O
  ─► iframe re-renders with X
  ─► iframe shows "Claude is thinking..."
  ─► iframe Pattern A: prompt "Your turn — board is …, call make_move"
  ─► Claude reads, picks a move, calls make_move(r, c)  server marks O, flips turn to X
  ─► (meanwhile) iframe polls get_game_state every 700ms→3s with backoff
  ─► poll detects turn flipped back to X
  ─► iframe re-renders with Claude's O
  ─► UI: "Your turn"
```

If Claude takes too long (timeout 45s), or makes an invalid move and gives up, you can hit **Nudge Claude** in the form to re-issue the prompt, or **New Game** to start over.

## Quickstart

```bash
pnpm install
pnpm dev          # MCP server on http://localhost:3000/mcp (Streamable HTTP)
```

To play in Claude Desktop:

1. Add (or update) `~/Library/Application Support/Claude/claude_desktop_config.json` with the snippet from [`examples/claude_desktop_config.json`](examples/claude_desktop_config.json), substituting `/ABSOLUTE/PATH/TO/...`.
2. Restart Claude Desktop.
3. Say: **"Let's play tic-tac-toe"** — Claude calls `play_tic_tac_toe`, the board renders, you click a cell, Claude responds.

You can verify the demo works in `ui-inspector` too (Streamable HTTP, `http://localhost:3000/mcp`), but Pattern A (Claude responding to prompts) only fires in real LLM hosts, so the inspector will show "Claude is thinking…" indefinitely.

## What this demo proves

Compared to the food/Swiggy demo on `main`, this one adds:

- **LLM as a game opponent** — not just the orchestrator. Claude reads a board state, reasons about strategy, and calls a tool with its move.
- **Bidirectional state polling** — iframe doesn't just push and forget; it polls `get_game_state` until Claude's move appears.
- **Mixed Pattern A + Pattern B in one flow** — human's clicks go via Pattern B (no LLM), Claude's moves come back via Pattern A (LLM in the loop). Same `make_move` tool serves both.

## Files

```
src/server.ts          ← everything: game state + 4 tools + UI template + lifecycle JS
docs/how-it-works.md   ← architecture (still mostly applies — substitute "cart" → "game")
examples/              ← Claude Desktop config snippet
```

## Going back to the food demo

```bash
git checkout main
```

## Possible follow-ups

- **Connect 4 / Othello** — same skeleton, just a bigger board. Server-side legal-move check stays simple.
- **Word games** — Claude generates a target word, the iframe is a Wordle-style guess grid; clicks call `submit_guess` and color the row.
- **Choose-your-own-adventure** — `start_adventure(theme)` returns a UI with intro + choices; clicking a choice fires `make_choice(choiceId)` which prompts Claude to write the next scene.
