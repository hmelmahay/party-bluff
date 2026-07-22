# 🎉 Party Bluff

A house-party bluffing trivia game. Everyone joins from their phone with a 4-letter room code. Each round shows a weird-but-true trivia question with a blank — every player writes a convincing **lie** to fill it, then everyone votes on which answer is the truth.

**Scoring**
- Pick the real answer when voting: **+1000 points**
- Every friend fooled by your lie: **+500 points**
- Accidentally type the real answer while writing your lie: **+500 bonus** (then you still have to write a lie!)

## Play locally

```bash
npm install
npm start
```

Open http://localhost:3000 on a couple of browser tabs (or phones on the same Wi-Fi using your computer's IP) — one player hosts, the rest join with the room code.

## How it works

| File | What it does |
|---|---|
| `server.js` | Express + Socket.IO server: rooms, game phases, scoring |
| `public/index.html` | The one page everyone loads (styles included) |
| `public/client.js` | Client logic: renders each game phase, talks to the server |
| `questions.json` | The trivia questions — **easiest place to contribute!** |

Game phases: `lobby → bluff → vote → reveal → (next question…) → gameover`

## Contributing (that's you, SpyderMYK 👋)

This repo is for learning GitHub collaboration. Suggested workflow:

1. **Clone** the repo: `git clone https://github.com/hmelmahay/party-bluff.git`
2. **Branch** for your change: `git checkout -b add-more-questions`
3. Make your change (try adding questions to `questions.json`!)
4. **Commit**: `git add -A && git commit -m "Add 5 new questions"`
5. **Push**: `git push -u origin add-more-questions`
6. Open a **Pull Request** on GitHub and request a review
7. Reviewer comments / approves → **merge** → delete the branch

Good first contributions:
- Add more questions to `questions.json` (format: `{"category": "Animal Kingdom", "question": "... ______.", "answer": "..."}` — see the file for the list of categories)
- Add a round timer so slow players can't stall the game
- Sound effects / animations on the reveal screen
- A dedicated "TV screen" view for casting to a big screen

Use the **Issues** tab to track ideas and bugs — that's part of the learning too.

## Deploying (free)

Deploys as a standard Node web service (works on Render's free tier):
- Build command: `npm install`
- Start command: `npm start`

The server listens on `process.env.PORT` automatically.
