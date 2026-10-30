const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const QUESTIONS_FILE = process.env.QUESTIONS_FILE || path.join(__dirname, "questions.json");
const QUESTIONS = JSON.parse(fs.readFileSync(QUESTIONS_FILE, "utf8"));
const CATEGORIES = [...new Set(QUESTIONS.map((q) => q.category).filter(Boolean))];
const QUESTIONS_PER_GAME = 5;
const POINTS_FOR_TRUTH = 1000;
const POINTS_PER_FOOL = 500;
const POINTS_FOR_GUESS = 500;
const MIN_CHOICES = 5;
const BOT_ID = "__bot__";
const BOT_NAME = "BluffBot 🤖";
// A dropped connection still counts as present this long, so a phone that slept
// or switched apps can rejoin without losing its turn or the host role
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS) || 15 * 1000;

// Compare loosely so "The Belt Buckle." still counts as guessing "belt buckle"
function normalizeAnswer(str) {
  return str
    .toLowerCase()
    .replace(/[.,!?'"]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^(a|an|the) /, "")
    .trim();
}

app.use(express.static(path.join(__dirname, "public")));

// rooms[code] = { hostId, phase, qIndex, questions, players: { playerId: {name, score, lie, vote, connected, token, socketId} } }
// Seats are keyed by playerId, not socket.id: a phone that sleeps comes back on a new
// socket and reclaims its seat with its token. playerId is public (it's in every
// state broadcast); the token is secret and only ever sent to its own player.
const rooms = {};

function makeCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join("");
  } while (rooms[code]);
  return code;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function publicPlayers(room) {
  return Object.entries(room.players).map(([id, p]) => ({
    id,
    name: p.name,
    score: p.score,
    connected: p.connected,
    submittedLie: p.lie !== null,
    voted: p.vote !== null,
  }));
}

function broadcast(code) {
  const room = rooms[code];
  if (!room) return;
  io.to(code).emit("state", {
    code,
    phase: room.phase,
    hostId: currentHostId(room),
    players: publicPlayers(room),
    qNumber: room.qIndex + 1,
    qTotal: room.questions.length,
    question: room.phase === "lobby" || room.phase === "gameover" ? null : room.questions[room.qIndex].question,
    category: room.phase === "lobby" || room.phase === "gameover" ? null : room.questions[room.qIndex].category || null,
    categories: room.phase === "lobby" ? CATEGORIES : null,
    choices: room.phase === "vote" || room.phase === "reveal" ? room.choices : null,
    reveal: room.phase === "reveal" || room.phase === "gameover" ? room.reveal : null,
  });
}

function activePlayers(room) {
  return Object.values(room.players).filter((p) => p.connected);
}

// The room's creator stays host. While they're disconnected the first connected
// player stands in, and the creator gets the controls back when they rejoin.
function currentHostId(room) {
  if (room.players[room.hostId].connected) return room.hostId;
  return Object.keys(room.players).find((id) => room.players[id].connected) || room.hostId;
}

function seatPlayer(socket, code, name) {
  const id = crypto.randomUUID();
  const token = crypto.randomUUID();
  rooms[code].players[id] = { name: name.slice(0, 20), score: 0, lie: null, vote: null, connected: true, token, socketId: socket.id };
  socket.join(code);
  socket.data.code = code;
  socket.data.playerId = id;
  return { ok: true, code, playerId: id, token };
}

function questionPool(category) {
  return category ? QUESTIONS.filter((q) => q.category === category) : QUESTIONS;
}

function startQuestion(code) {
  const room = rooms[code];
  room.phase = "bluff";
  room.choices = null;
  room.reveal = null;
  for (const p of Object.values(room.players)) {
    p.lie = null;
    p.vote = null;
    p.guessedTruth = false;
  }
  broadcast(code);
}

function maybeStartVoting(code) {
  const room = rooms[code];
  const waiting = activePlayers(room).some((p) => p.lie === null);
  if (waiting) return;

  const q = room.questions[room.qIndex];
  const truth = { text: q.answer, isTruth: true, ownerId: null };
  const lies = Object.entries(room.players)
    .filter(([, p]) => p.lie !== null)
    .map(([id, p]) => ({ text: p.lie, isTruth: false, ownerId: id }));

  // With few players there aren't enough lies to hide the truth in, so
  // BluffBot pads the ballot to MIN_CHOICES. Each question ships with
  // hand-written decoys; category/any answers are only a fallback.
  const used = new Set([truth, ...lies].map((c) => normalizeAnswer(c.text)));
  const sameCategory = QUESTIONS.filter((x) => x.category === q.category).map((x) => x.answer);
  const anyCategory = QUESTIONS.map((x) => x.answer);
  const botLies = [];
  for (const cand of [...shuffle(q.decoys || []), ...shuffle(sameCategory), ...shuffle(anyCategory)]) {
    if (1 + lies.length + botLies.length >= MIN_CHOICES) break;
    const n = normalizeAnswer(cand);
    if (used.has(n)) continue;
    used.add(n);
    botLies.push({ text: cand, isTruth: false, ownerId: BOT_ID });
  }

  // Display every choice starting lowercase — if only some entries kept
  // their capitalization, case would leak who (or what) wrote them.
  const combined = shuffle([truth, ...lies, ...botLies]).map((c) => ({
    ...c,
    text: c.text.charAt(0).toLowerCase() + c.text.slice(1),
  }));
  room.choiceMeta = combined;
  room.choices = combined.map((c, i) => ({ index: i, text: c.text }));
  room.phase = "vote";
  broadcast(code);
}

function maybeReveal(code) {
  const room = rooms[code];
  const waiting = activePlayers(room).some((p) => p.vote === null);
  if (waiting) return;

  const results = [];
  for (const [id, p] of Object.entries(room.players)) {
    if (p.vote === null) continue;
    const choice = room.choiceMeta[p.vote];
    if (!choice) continue;
    if (choice.isTruth) {
      p.score += POINTS_FOR_TRUTH;
      results.push({ voter: p.name, pickedTruth: true, fooledBy: null });
    } else if (choice.ownerId === BOT_ID) {
      results.push({ voter: p.name, pickedTruth: false, fooledBy: BOT_NAME });
    } else {
      const owner = room.players[choice.ownerId];
      if (owner && choice.ownerId !== id) owner.score += POINTS_PER_FOOL;
      results.push({ voter: p.name, pickedTruth: false, fooledBy: owner ? owner.name : "?" });
    }
  }
  room.reveal = {
    answer: room.questions[room.qIndex].answer,
    truthGuessers: Object.values(room.players).filter((p) => p.guessedTruth).map((p) => p.name),
    results,
    scores: publicPlayers(room)
      .map((p) => ({ name: p.name, score: p.score }))
      .sort((a, b) => b.score - a.score),
  };
  room.phase = "reveal";
  broadcast(code);
}

io.on("connection", (socket) => {
  socket.on("createRoom", ({ name }, cb) => {
    const code = makeCode();
    rooms[code] = {
      hostId: null,
      phase: "lobby",
      qIndex: 0,
      questions: shuffle(QUESTIONS).slice(0, QUESTIONS_PER_GAME),
      players: {},
      choices: null,
      choiceMeta: null,
      reveal: null,
    };
    const seat = seatPlayer(socket, code, name);
    rooms[code].hostId = seat.playerId;
    cb(seat);
    broadcast(code);
  });

  socket.on("joinRoom", ({ code, name }, cb) => {
    code = (code || "").toUpperCase().trim();
    const room = rooms[code];
    if (!room) return cb({ ok: false, error: "Room not found." });
    if (room.phase !== "lobby") return cb({ ok: false, error: "Game already started." });
    if (Object.keys(room.players).length >= 12) return cb({ ok: false, error: "Room is full (12 max)." });
    cb(seatPlayer(socket, code, name));
    broadcast(code);
  });

  // A reconnecting phone has a new socket.id, so it proves who it is with the
  // token it got from createRoom/joinRoom. Works in any phase, unlike joinRoom.
  socket.on("rejoin", (data, cb = () => {}) => {
    const { code: rawCode, token } = data || {};
    // Normalize like joinRoom; uppercasing also stops "__proto__" & co. matching a room
    const code = String(rawCode || "").toUpperCase().trim();
    const room = rooms[code];
    const id = room && Object.keys(room.players).find((pid) => room.players[pid].token === token);
    if (!id) return cb({ ok: false, error: "That game has ended." });
    const p = room.players[id];
    // Only the newest socket speaks for a seat. The old one may be a dead
    // connection the server hasn't timed out yet, or a duplicated tab. Wiping
    // its data also makes its eventual disconnect a no-op.
    const old = io.sockets.sockets.get(p.socketId);
    if (old && old !== socket) {
      old.leave(code);
      old.data = {};
      old.emit("replaced");
    }
    clearTimeout(p.leaveTimer);
    p.socketId = socket.id;
    p.connected = true;
    socket.join(code);
    socket.data.code = code;
    socket.data.playerId = id;
    cb({ ok: true, code, playerId: id });
    broadcast(code);
    // If everyone else left mid-round, the round may only have been waiting on them
    if (room.phase === "bluff") maybeStartVoting(code);
    if (room.phase === "vote") maybeReveal(code);
  });

  socket.on("startGame", (opts) => {
    const room = rooms[socket.data.code];
    if (!room || currentHostId(room) !== socket.data.playerId || room.phase !== "lobby") return;
    if (activePlayers(room).length < 2) {
      socket.emit("errorMsg", "Need at least 2 players.");
      return;
    }
    const count = Math.max(3, Math.min(20, parseInt(opts && opts.count, 10) || 5));
    // Unknown categories (or none) mean the full mix
    const category = CATEGORIES.includes(opts && opts.category) ? opts.category : null;
    room.qCount = count;
    room.qCategory = category;
    room.questions = shuffle(questionPool(category)).slice(0, count);
    startQuestion(socket.data.code);
  });

  socket.on("submitLie", ({ lie }, cb = () => {}) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.phase !== "bluff") return cb({ ok: false, error: "Not accepting lies right now." });
    const p = room.players[socket.data.playerId];
    if (!p || p.lie !== null) return cb({ ok: false, error: "Lie already submitted." });
    lie = (lie || "").trim().slice(0, 60);
    if (!lie) return cb({ ok: false, error: "Write something first!" });
    // Guessing the real answer earns a bonus — then you still owe us a lie
    if (normalizeAnswer(lie) === normalizeAnswer(room.questions[room.qIndex].answer)) {
      if (!p.guessedTruth) {
        p.guessedTruth = true;
        p.score += POINTS_FOR_GUESS;
        broadcast(code);
        return cb({ ok: false, guessedTruth: true, error: `🎯 You guessed the REAL answer! +${POINTS_FOR_GUESS} points. Now write a lie to fool the others.` });
      }
      return cb({ ok: false, error: "That's the real answer — you already got your bonus. Write a lie!" });
    }
    p.lie = lie;
    cb({ ok: true });
    broadcast(code);
    maybeStartVoting(code);
  });

  socket.on("submitVote", ({ index }, cb = () => {}) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.phase !== "vote") return cb({ ok: false, error: "Not accepting votes right now." });
    const p = room.players[socket.data.playerId];
    if (!p || p.vote !== null) return cb({ ok: false, error: "Vote already cast." });
    const choice = room.choiceMeta[index];
    if (!choice) return cb({ ok: false, error: "Invalid choice." });
    if (choice.ownerId === socket.data.playerId) {
      return cb({ ok: false, error: "You can't vote for your own lie!" });
    }
    p.vote = index;
    cb({ ok: true });
    broadcast(code);
    maybeReveal(code);
  });

  socket.on("nextQuestion", () => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || currentHostId(room) !== socket.data.playerId || room.phase !== "reveal") return;
    if (room.qIndex + 1 >= room.questions.length) {
      room.phase = "gameover";
      broadcast(code);
    } else {
      room.qIndex++;
      startQuestion(code);
    }
  });

  socket.on("playAgain", () => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || currentHostId(room) !== socket.data.playerId || room.phase !== "gameover") return;
    room.qIndex = 0;
    room.questions = shuffle(questionPool(room.qCategory)).slice(0, room.qCount || QUESTIONS_PER_GAME);
    for (const p of Object.values(room.players)) p.score = 0;
    startQuestion(code);
  });

  socket.on("disconnect", () => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room) return;
    const p = room.players[socket.data.playerId];
    if (!p) return;
    // Nobody sees the player leave until RECONNECT_GRACE_MS passes without a rejoin
    clearTimeout(p.leaveTimer);
    p.leaveTimer = setTimeout(() => {
      if (rooms[code] !== room) return;
      p.connected = false;
      // If everyone is gone, delete the room after a grace period
      if (activePlayers(room).length === 0) {
        setTimeout(() => {
          if (rooms[code] && activePlayers(rooms[code]).length === 0) delete rooms[code];
        }, 5 * 60 * 1000);
      } else {
        // Don't stall the round on a disconnected player
        if (room.phase === "bluff") maybeStartVoting(code);
        if (room.phase === "vote") maybeReveal(code);
        broadcast(code);
      }
    }, RECONNECT_GRACE_MS);
  });
});

server.listen(PORT, () => {
  console.log(`Party Bluff running on http://localhost:${PORT}`);
});
