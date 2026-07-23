# CLAUDE.md — Party Bluff

Fibbage-style bluffing trivia game for house parties. This is a **GitHub-learning collaboration project** between Steve (hmelmahay) and Mike (SpyderMYK) — prefer proper GitHub flow (branch → PR → review → merge) over pushing straight to main, since practicing that flow is half the point of the repo.

## What the game is

Players join from their phones with a 4-letter room code (2–12 per room). Each round shows a weird-but-true trivia question with a blank; every player writes a convincing lie, then everyone votes on which answer is the truth.

**Scoring:**
- Vote for the real answer: +1000
- Each player fooled by your lie: +500
- Type the real answer while writing your lie: +500 bonus (once per question), then you still submit a lie
- Votes for BluffBot answers score nobody anything

**Game rules baked into the server:**
- Ballot always has ≥5 choices — with <4 players, BluffBot 🤖 pads it using the question's hand-written `decoys` (fallback: answers from other questions, same category first)
- Every ballot entry is displayed starting lowercase so capitalization never reveals which answers came from the JSON vs. typed by players
- Host picks game length in the lobby: 3/5/10/15/20 questions (server clamps 3–20; Play Again reuses it)
- Lie/answer matching is fuzzy: case, punctuation, and leading a/an/the are ignored
- Phases: `lobby → bluff → vote → reveal → (repeat) → gameover`

## Architecture

| File | Role |
|---|---|
| `server.js` | Express + Socket.IO. All game state lives in the in-memory `rooms` object — a restart drops every active game. All state changes broadcast via a single `state` event. |
| `public/client.js` | One-page vanilla JS client; renders per phase off the `state` event. Submissions use Socket.IO acks — never lock UI optimistically, only after the server's `{ok:true}`. |
| `public/index.html` | Markup + all styles (navy/orange theme via CSS variables). |
| `questions.json` | 200 questions, 25 per category × 8 categories, grouped by category. Format: `{category, question ("… ______."), answer, decoys: [3 plausible fakes]}`. Answers must be TRUE facts (the game reveals them as truth). Decoys must fit the blank grammatically, be false, and never equal the answer. |

## Running & testing

```bash
npm install
npm start          # http://localhost:3000, or PORT=xxxx
```

- `QUESTIONS_FILE=/path/to/fixture.json` env var overrides the question set — used by the automated tests
- Tests are standalone Node scripts using `socket.io-client` (install with `npm i --no-save socket.io-client`): they spawn the server on a spare port with a fixture questions file and play scripted rounds asserting phases/scores/ballots. Past suites covered: guess bonus, no double bonus, bot padding to 5, lowercase display, host question count, fool points. Re-run/extend that pattern when touching game logic.

## Deployment (Render)

- Live at **https://party-bluff.onrender.com** — free tier, so it sleeps when idle (first visit after a quiet spell takes ~50s) and a sleep drops in-memory rooms
- Deploys from `render.yaml` blueprint (Node, `npm install` / `npm start`), service name `party-bluff` on Steve's Render account
- ⚠️ **Merging to main does NOT auto-deploy.** The repo was connected by public URL, so Render has no webhook. After merging, deploy manually: Render dashboard → party-bluff → Manual Deploy → "Deploy latest commit". (Fix someday: install the Render GitHub app on this repo, then merges auto-deploy.)
- Verify a deploy landed by curling a string only the new code contains, e.g. `curl -s https://party-bluff.onrender.com/client.js | grep <new-code-marker>`

## Conventions & gotchas

- Steve's local clone: `~/Projects/party-bluff`. This project is intentionally NOT under `~/Properties` (that's Steve's landlord workspace) — don't file property-related things here or game things there.
- GitHub CLI (`gh`) is authenticated as hmelmahay; SpyderMYK has push access
- "Close pull request" ≠ merge — that mistake has been made once already; the green **Merge pull request** button is the one that ships
- When adding questions: verify facts are true, keep answers short enough to vote on (≤60 chars), include the `______` blank, add 3 decoys, and don't duplicate an existing question or let a decoy collide with any true answer
- Ideas parked as future work: show category name during rounds, host picks category in the lobby, round timer, sounds/animations on reveal, dedicated TV-screen view
