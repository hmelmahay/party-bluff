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
- Host picks a category in the lobby (or "Mix of everything"; unknown categories fall back to the mix; Play Again reuses it). The current question's category shows in the progress line during rounds.
- Lie/answer matching is fuzzy: case, punctuation, and leading a/an/the are ignored
- Phases: `lobby → bluff → vote → reveal → (repeat) → gameover`
- Rejoin:  seats are keyed by a server-made `playerId` (public, in every `state`) plus a secret `token` (only in that player's create/join ack, never broadcast).  On every socket (re)connect the client emits `rejoin {code, token}` from `sessionStorage` (per tab, so a reload rejoins but a second tab is a new player) and gets its seat, score, lie and vote back in any phase.  New players still can't join after the lobby.  The newest socket wins a seat, and the older one gets a `replaced` event.
- Reconnect grace:  a dropped connection still counts as present for `RECONNECT_GRACE_MS` (15 s, env var override for tests).  A rejoin inside that window costs nothing:  nobody sees the player leave and the round waits for their lie or vote.  After it, they show as gone and the round stops waiting for them.  A rejoin also re-checks whether the round can move on, so it never waits on players who are all gone.
- Host:  the room creator stays host.  Once they've been gone past the grace, the first connected player stands in (`currentHostId()`), and the creator gets the controls back on rejoin.

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
- `node test/reconnect.js` is the one committed suite.  It runs the server with a 1-second grace, drops players mid-round and the host at a reveal, rejoins them on new sockets, and checks seat, score, host role, drops shorter and longer than the grace, and that tokens never appear in `state`.  Takes about 6 s.

## Deployment (Render)

- Live at **https://party-bluff.onrender.com** — free tier, so it sleeps when idle (first visit after a quiet spell takes ~50s) and a sleep drops in-memory rooms
- Deploys from `render.yaml` blueprint (Node, `npm install` / `npm start`), service name `party-bluff` on Steve's Render account
- Pushes to main auto-deploy via `.github/workflows/deploy.yml`, which pings the Render deploy hook (repo secret `RENDER_DEPLOY_HOOK`). If the secret is unset the workflow no-ops — then deploy manually: Render dashboard → party-bluff → Manual Deploy → "Deploy latest commit".
- Verify a deploy landed by curling a string only the new code contains, e.g. `curl -s https://party-bluff.onrender.com/client.js | grep <new-code-marker>`

## Conventions & gotchas

- Steve's local clone: `~/Projects/party-bluff`. This project is intentionally NOT under `~/Properties` (that's Steve's landlord workspace) — don't file property-related things here or game things there.
- GitHub CLI (`gh`) is authenticated as hmelmahay; SpyderMYK has push access
- "Close pull request" ≠ merge — that mistake has been made once already; the green **Merge pull request** button is the one that ships
- When adding questions: verify facts are true, keep answers short enough to vote on (≤60 chars), include the `______` blank, add 3 decoys, and don't duplicate an existing question or let a decoy collide with any true answer
- Ideas parked as future work: round timer, sounds/animations on reveal, dedicated TV-screen view
