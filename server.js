const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, "questions.json"), "utf8"));
const QUESTIONS_PER_GAME = 5;
const POINTS_FOR_TRUTH = 1000;
const POINTS_PER_FOOL = 500;

app.use(express.static(path.join(__dirname, "public")));

// rooms[code] = { hostId, phase, qIndex, questions, players: { socketId: {name, score, lie, vote, connected} } }
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
    hostId: room.hostId,
    players: publicPlayers(room),
    qNumber: room.qIndex + 1,
    qTotal: room.questions.length,
    question: room.phase === "lobby" || room.phase === "gameover" ? null : room.questions[room.qIndex].question,
    choices: room.phase === "vote" || room.phase === "reveal" ? room.choices : null,
    reveal: room.phase === "reveal" || room.phase === "gameover" ? room.reveal : null,
  });
}

function activePlayers(room) {
  return Object.values(room.players).filter((p) => p.connected);
}

function startQuestion(code) {
  const room = rooms[code];
  room.phase = "bluff";
  room.choices = null;
  room.reveal = null;
  for (const p of Object.values(room.players)) {
    p.lie = null;
    p.vote = null;
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
  const combined = shuffle([truth, ...lies]);
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
    } else {
      const owner = room.players[choice.ownerId];
      if (owner && choice.ownerId !== id) owner.score += POINTS_PER_FOOL;
      results.push({ voter: p.name, pickedTruth: false, fooledBy: owner ? owner.name : "?" });
    }
  }
  room.reveal = {
    answer: room.questions[room.qIndex].answer,
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
      hostId: socket.id,
      phase: "lobby",
      qIndex: 0,
      questions: shuffle(QUESTIONS).slice(0, QUESTIONS_PER_GAME),
      players: {},
      choices: null,
      choiceMeta: null,
      reveal: null,
    };
    rooms[code].players[socket.id] = { name: name.slice(0, 20), score: 0, lie: null, vote: null, connected: true };
    socket.join(code);
    socket.data.code = code;
    cb({ ok: true, code });
    broadcast(code);
  });

  socket.on("joinRoom", ({ code, name }, cb) => {
    code = (code || "").toUpperCase().trim();
    const room = rooms[code];
    if (!room) return cb({ ok: false, error: "Room not found." });
    if (room.phase !== "lobby") return cb({ ok: false, error: "Game already started." });
    if (Object.keys(room.players).length >= 12) return cb({ ok: false, error: "Room is full (12 max)." });
    room.players[socket.id] = { name: name.slice(0, 20), score: 0, lie: null, vote: null, connected: true };
    socket.join(code);
    socket.data.code = code;
    cb({ ok: true, code });
    broadcast(code);
  });

  socket.on("startGame", () => {
    const room = rooms[socket.data.code];
    if (!room || room.hostId !== socket.id || room.phase !== "lobby") return;
    if (activePlayers(room).length < 2) {
      socket.emit("errorMsg", "Need at least 2 players.");
      return;
    }
    startQuestion(socket.data.code);
  });

  socket.on("submitLie", ({ lie }, cb = () => {}) => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room || room.phase !== "bluff") return cb({ ok: false, error: "Not accepting lies right now." });
    const p = room.players[socket.id];
    if (!p || p.lie !== null) return cb({ ok: false, error: "Lie already submitted." });
    lie = (lie || "").trim().slice(0, 60);
    if (!lie) return cb({ ok: false, error: "Write something first!" });
    // Reject lies that match the real answer
    if (lie.toLowerCase() === room.questions[room.qIndex].answer.toLowerCase()) {
      return cb({ ok: false, error: "Too close to the truth! Try a different lie." });
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
    const p = room.players[socket.id];
    if (!p || p.vote !== null) return cb({ ok: false, error: "Vote already cast." });
    const choice = room.choiceMeta[index];
    if (!choice) return cb({ ok: false, error: "Invalid choice." });
    if (choice.ownerId === socket.id) {
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
    if (!room || room.hostId !== socket.id || room.phase !== "reveal") return;
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
    if (!room || room.hostId !== socket.id || room.phase !== "gameover") return;
    room.qIndex = 0;
    room.questions = shuffle(QUESTIONS).slice(0, QUESTIONS_PER_GAME);
    for (const p of Object.values(room.players)) p.score = 0;
    startQuestion(code);
  });

  socket.on("disconnect", () => {
    const code = socket.data.code;
    const room = rooms[code];
    if (!room) return;
    const p = room.players[socket.id];
    if (p) p.connected = false;
    // If everyone is gone, delete the room after a grace period
    if (activePlayers(room).length === 0) {
      setTimeout(() => {
        if (rooms[code] && activePlayers(rooms[code]).length === 0) delete rooms[code];
      }, 5 * 60 * 1000);
    } else {
      // Hand host to another connected player if the host left
      if (room.hostId === socket.id) {
        const next = Object.entries(room.players).find(([, pl]) => pl.connected);
        if (next) room.hostId = next[0];
      }
      // Don't stall the round on a disconnected player
      if (room.phase === "bluff") maybeStartVoting(code);
      if (room.phase === "vote") maybeReveal(code);
      broadcast(code);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Party Bluff running on http://localhost:${PORT}`);
});
