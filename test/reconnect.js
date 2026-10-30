// Reconnect test: a player who drops mid-round, and the host, come back on a
// new socket with their rejoin token and keep their seat, score and host role.
//
//   npm i --no-save socket.io-client
//   node test/reconnect.js
const assert = require("assert");
const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { io } = require("socket.io-client");

const QUESTIONS = [1, 2, 3].map((n) => ({
  category: "Test",
  question: `Fixture question ${n} is ______.`,
  answer: `truth ${n}`,
  decoys: [`decoy ${n}a`, `decoy ${n}b`, `decoy ${n}c`],
}));
const truthOf = (st) => QUESTIONS.find((q) => q.question === st.question).answer;

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "party-bluff-"));
  const questionsFile = path.join(dir, "questions.json");
  fs.writeFileSync(questionsFile, JSON.stringify(QUESTIONS));
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(port), QUESTIONS_FILE: questionsFile },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    proc.stdout.on("data", (d) => String(d).includes("running") && resolve());
    proc.on("exit", (code) => reject(new Error(`server exited with ${code}`)));
  });
  return {
    url: `http://localhost:${port}`,
    stop() {
      proc.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const seenStates = []; // every state any client received, to prove no token leaks
const sockets = [];

async function connect(url) {
  const s = io(url, { forceNew: true, transports: ["websocket"], reconnection: false });
  sockets.push(s);
  s.latest = null;
  s.on("state", (st) => {
    s.latest = st;
    seenStates.push(st);
  });
  await new Promise((resolve, reject) => {
    s.once("connect", resolve);
    s.once("connect_error", reject);
  });
  return s;
}

function ask(s, event, data) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply to "${event}" (did the server crash?)`)), 3000);
    s.emit(event, data, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

// Round-trip on this socket (a rejoin with no token is a no-op), so every state
// the server queued for it before now has arrived
const sync = (s) => ask(s, "rejoin", {});

function waitFor(s, label, pred) {
  return new Promise((resolve, reject) => {
    if (s.latest && pred(s.latest)) return resolve(s.latest);
    const timer = setTimeout(() => {
      s.off("state", check);
      reject(new Error(`timed out waiting for: ${label}`));
    }, 3000);
    function check(st) {
      if (!pred(st)) return;
      clearTimeout(timer);
      s.off("state", check);
      resolve(st);
    }
    s.on("state", check);
  });
}

function waitForEvent(s, event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), 3000);
    s.once(event, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const player = (st, id) => st.players.find((p) => p.id === id);
const scores = (st) => Object.fromEntries(st.players.map((p) => [p.name, p.score]));

function choiceIndex(st, text) {
  const c = st.choices.find((x) => x.text === text);
  assert.ok(c, `ballot is missing "${text}"`);
  return c.index;
}

async function lie(s, text) {
  const res = await ask(s, "submitLie", { lie: text });
  assert.ok(res.ok, `lie "${text}" refused: ${res.error}`);
}

async function vote(s, st, text) {
  const res = await ask(s, "submitVote", { index: choiceIndex(st, text) });
  assert.ok(res.ok, `vote for "${text}" refused: ${res.error}`);
}

const pass = (msg) => console.log(`  ✓ ${msg}`);

async function run(url) {
  // Lobby: Ann hosts, Bob and Cat join
  const ann = await connect(url);
  const annSeat = await ask(ann, "createRoom", { name: "Ann" });
  assert.ok(annSeat.ok && annSeat.token && annSeat.playerId, "createRoom returns a seat with a token");
  const { code } = annSeat;
  const bob = await connect(url);
  const bobSeat = await ask(bob, "joinRoom", { code, name: "Bob" });
  const cat = await connect(url);
  const catSeat = await ask(cat, "joinRoom", { code, name: "Cat" });
  assert.ok(bobSeat.ok && catSeat.ok, "Bob and Cat join");
  const ANN = annSeat.playerId;
  const BOB = bobSeat.playerId;
  const CAT = catSeat.playerId;

  // Question 1, played normally to bank some points
  ann.emit("startGame", { count: 3 });
  await waitFor(ann, "question 1", (s) => s.phase === "bluff" && s.qNumber === 1);
  await lie(ann, "ann lie 1");
  await lie(bob, "bob lie 1");
  await lie(cat, "cat lie 1");
  let st = await waitFor(ann, "question 1 vote", (s) => s.phase === "vote" && s.qNumber === 1);
  await vote(ann, st, truthOf(st)); // Ann +1000
  await vote(bob, st, truthOf(st)); // Bob +1000
  await vote(cat, st, "bob lie 1"); // Bob +500
  st = await waitFor(ann, "question 1 reveal", (s) => s.phase === "reveal" && s.qNumber === 1);
  assert.deepStrictEqual(scores(st), { Ann: 1000, Bob: 1500, Cat: 0 });
  ann.emit("nextQuestion");
  await waitFor(ann, "question 2", (s) => s.phase === "bluff" && s.qNumber === 2);

  // Question 2: Bob's connection drops mid-round, before he writes his lie
  await lie(ann, "ann lie 2");
  bob.disconnect();
  st = await waitFor(ann, "Bob shown as disconnected", (s) => player(s, BOB).connected === false);
  assert.strictEqual(st.phase, "bluff");

  const bob2 = await connect(url);
  const bobBack = await ask(bob2, "rejoin", { code, token: bobSeat.token });
  assert.ok(bobBack.ok, `Bob's rejoin refused: ${bobBack.error}`);
  assert.strictEqual(bobBack.playerId, BOB, "Bob gets his own seat back");
  st = await waitFor(bob2, "Bob reconnected", (s) => player(s, BOB).connected === true);
  assert.strictEqual(st.players.length, 3, "no duplicate seat");
  assert.strictEqual(player(st, BOB).name, "Bob");
  assert.strictEqual(player(st, BOB).score, 1500, "Bob keeps his score");
  assert.strictEqual(st.phase, "bluff");
  assert.strictEqual(st.qNumber, 2);
  pass("player dropped mid-round rejoins on a new socket: same seat, same score (1500)");

  await lie(cat, "cat lie 2");
  await sync(ann);
  assert.strictEqual(ann.latest.phase, "bluff", "round waits for Bob again now he's back");
  await lie(bob2, "bob lie 2");
  st = await waitFor(ann, "question 2 vote", (s) => s.phase === "vote" && s.qNumber === 2);
  const own = await ask(bob2, "submitVote", { index: choiceIndex(st, "bob lie 2") });
  assert.ok(!own.ok && /own lie/.test(own.error), "Bob still can't vote for his own lie");
  await vote(ann, st, truthOf(st)); // Ann +1000
  await vote(bob2, st, truthOf(st)); // Bob +1000
  await vote(cat, st, "bob lie 2"); // Bob +500, to the rejoined seat
  st = await waitFor(ann, "question 2 reveal", (s) => s.phase === "reveal" && s.qNumber === 2);
  assert.deepStrictEqual(scores(st), { Ann: 2000, Bob: 3000, Cat: 0 });
  pass("rejoined player's lie, vote and fool points all count (Bob 3000)");

  // Host drops at the reveal: Bob stands in, then Ann rejoins and is host again
  ann.disconnect();
  st = await waitFor(bob2, "Ann shown as disconnected", (s) => player(s, ANN).connected === false);
  assert.strictEqual(st.hostId, BOB, "first connected player stands in as host");

  const ann2 = await connect(url);
  const annBack = await ask(ann2, "rejoin", { code, token: annSeat.token });
  assert.ok(annBack.ok, `Ann's rejoin refused: ${annBack.error}`);
  assert.strictEqual(annBack.playerId, ANN, "Ann gets her own seat back");
  st = await waitFor(ann2, "Ann reconnected", (s) => player(s, ANN).connected === true);
  assert.strictEqual(st.hostId, ANN, "host role comes back on rejoin");
  assert.strictEqual(player(st, ANN).score, 2000, "Ann keeps her score");
  assert.strictEqual(st.players.length, 3, "no duplicate seat");
  assert.strictEqual(st.phase, "reveal");
  bob2.emit("nextQuestion");
  await sync(bob2);
  assert.strictEqual(bob2.latest.phase, "reveal", "stand-in loses host controls once Ann is back");
  ann2.emit("nextQuestion");
  await waitFor(ann2, "question 3", (s) => s.phase === "bluff" && s.qNumber === 3);
  pass("host drops: Bob stands in, Ann rejoins with her score (2000) and host controls");

  // Question 3: Cat reopens the game while her old connection still looks alive
  // (what the server sees when a sleeping phone's socket hasn't timed out yet)
  const cat2 = await connect(url);
  const replaced = waitForEvent(cat, "replaced");
  const catBack = await ask(cat2, "rejoin", { code, token: catSeat.token });
  assert.ok(catBack.ok, `Cat's rejoin refused: ${catBack.error}`);
  assert.strictEqual(catBack.playerId, CAT, "Cat gets her own seat back");
  await replaced;
  const stale = await ask(cat, "submitLie", { lie: "stale tab" });
  assert.ok(!stale.ok, "old socket can no longer act for the seat");
  cat.disconnect(); // the old socket finally goes away
  await lie(ann2, "ann lie 3");
  await lie(bob2, "bob lie 3");
  await sync(ann2);
  assert.strictEqual(player(ann2.latest, CAT).connected, true, "old socket's disconnect doesn't knock Cat out");
  assert.strictEqual(ann2.latest.phase, "bluff", "round still waits on Cat");
  await lie(cat2, "cat lie 3");
  st = await waitFor(ann2, "question 3 vote", (s) => s.phase === "vote" && s.qNumber === 3);
  await vote(ann2, st, truthOf(st)); // Ann +1000
  await vote(bob2, st, "cat lie 3"); // Cat +500
  await vote(cat2, st, truthOf(st)); // Cat +1000
  st = await waitFor(ann2, "question 3 reveal", (s) => s.phase === "reveal" && s.qNumber === 3);
  assert.deepStrictEqual(scores(st), { Ann: 3000, Bob: 3000, Cat: 1500 });
  ann2.emit("nextQuestion");
  await waitFor(ann2, "game over", (s) => s.phase === "gameover");
  pass("rejoin while the old socket is still open: old one is cut off, Cat plays on (1500)");

  // Existing rules still hold, and tokens stay private
  const dan = await connect(url);
  const late = await ask(dan, "joinRoom", { code, name: "Dan" });
  assert.ok(!late.ok && /already started/.test(late.error), "new players still can't join after the lobby");
  const fake = await ask(dan, "rejoin", { code, token: "not-a-real-token" });
  assert.ok(!fake.ok, "a wrong token can't take a seat");
  for (const junk of [null, "TBSW", { code: "__proto__" }, { code: "constructor", token: 1 }, { code: 42 }]) {
    assert.ok(!(await ask(dan, "rejoin", junk)).ok, `junk rejoin ${JSON.stringify(junk)} is refused`);
  }
  const annReplaced = waitForEvent(ann2, "replaced"); // the next rejoin moves Ann's seat to Dan's socket
  const lower = await ask(dan, "rejoin", { code: code.toLowerCase(), token: annSeat.token });
  assert.ok(lower.ok && lower.playerId === ANN, "room code is case-insensitive on rejoin");
  await annReplaced;
  const everything = JSON.stringify(seenStates);
  for (const seat of [annSeat, bobSeat, catSeat]) {
    assert.ok(!everything.includes(seat.token), "a token showed up in a state broadcast");
  }
  pass(`no late joins, no fake or junk rejoins, no tokens in ${seenStates.length} state broadcasts`);
}

(async () => {
  process.exitCode = 1; // stays failed unless every check passes, even if the run dies quietly
  const server = await startServer();
  try {
    console.log("reconnect test");
    await run(server.url);
    console.log("PASS");
    process.exitCode = 0;
  } catch (err) {
    console.error("FAIL:", err.message);
  } finally {
    for (const s of sockets) s.disconnect();
    server.stop();
  }
})();
