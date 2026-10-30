const socket = io();
const screen = document.getElementById("screen");
const toast = document.getElementById("toast");
const SESSION_KEY = "partyBluffSession";

let state = null;
let myId = null;
let session = loadSession(); // { code, token } from createRoom/joinRoom, for rejoining
let submittedLie = false;
let votedIndex = null;
let lieDraft = ""; // the lie box's text, so a re-render mid-typing doesn't wipe it
let lobbyQCount = null;
let lobbyCategory = null;

// sessionStorage (not localStorage) so a reload of this tab rejoins, while a
// second tab on the same device can still join as a different player
function loadSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch (e) { return null; }
}

function saveSession(res) {
  session = { code: res.code, token: res.token };
  myId = res.playerId;
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) {}
}

function forgetSession() {
  session = null;
  myId = null;
  state = null;
  try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
}

// A phone that sleeps comes back on a new socket.id, so every (re)connect
// reclaims our seat — score, lie, vote and host role — with the token
socket.on("connect", () => {
  if (!session) return;
  socket.emit("rejoin", session, (res) => {
    if (res.ok) {
      myId = res.playerId;
    } else {
      forgetSession();
      render();
      showToast(res.error);
    }
  });
});

socket.on("replaced", () => {
  forgetSession();
  render();
  showToast("You rejoined this game from another tab.");
});

socket.on("errorMsg", (msg) => showToast(msg));

socket.on("state", (s) => {
  // Question text too:  a phone that slept through Play Again can wake up at
  // the same phase and question number of the next game
  const phaseChanged = !state || state.phase !== s.phase || state.qNumber !== s.qNumber || state.question !== s.question;
  state = s;
  if (phaseChanged) {
    submittedLie = false;
    votedIndex = null;
    lieDraft = "";
  }
  // The server's "not yet" beats a lock left over from an earlier round,
  // even one that drew the same question
  const mine = me();
  if (mine && !mine.submittedLie) submittedLie = false;
  if (mine && !mine.voted) votedIndex = null;
  render();
});

let toastTimer = null;
function showToast(msg) {
  toast.textContent = msg;
  toast.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.style.display = "none"), Math.max(2500, msg.length * 60));
}

function esc(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function me() {
  return state && state.players.find((p) => p.id === myId);
}

function isHost() {
  return state && state.hostId === myId;
}

function render() {
  if (!state) return renderJoin();
  switch (state.phase) {
    case "lobby": return renderLobby();
    case "bluff": return renderBluff();
    case "vote": return renderVote();
    case "reveal": return renderReveal();
    case "gameover": return renderGameOver();
  }
}

function renderJoin() {
  screen.innerHTML = `
    <div class="card">
      <div class="label">Your name</div>
      <input type="text" id="name" maxlength="20" placeholder="e.g. Steve" autocomplete="off" />
      <div class="label">Join a game</div>
      <input type="text" id="code" maxlength="4" placeholder="Room code (4 letters)" autocomplete="off" style="text-transform:uppercase" />
      <button id="joinBtn">Join Game</button>
      <button id="createBtn" class="secondary">Host a New Game</button>
    </div>`;
  const name = () => document.getElementById("name").value.trim();
  document.getElementById("createBtn").onclick = () => {
    if (!name()) return showToast("Enter your name first!");
    socket.emit("createRoom", { name: name() }, (res) => {
      if (res.ok) saveSession(res);
      else showToast(res.error);
    });
  };
  document.getElementById("joinBtn").onclick = () => {
    if (!name()) return showToast("Enter your name first!");
    const code = document.getElementById("code").value;
    if (!code) return showToast("Enter the room code!");
    socket.emit("joinRoom", { code, name: name() }, (res) => {
      if (res.ok) saveSession(res);
      else showToast(res.error);
    });
  };
}

function renderLobby() {
  screen.innerHTML = `
    <div class="card">
      <div class="label">Room code — friends join at this site with:</div>
      <div class="roomcode">${esc(state.code)}</div>
    </div>
    <div class="card">
      <div class="label">Players (${state.players.length})</div>
      <ul class="players">
        ${state.players.map((p) => `<li><span>${esc(p.name)}${p.id === state.hostId ? " 👑" : ""}</span><span class="status">${p.connected ? "" : "left"}</span></li>`).join("")}
      </ul>
    </div>
    ${isHost()
      ? `<div class="card">
           <div class="label">Questions this game</div>
           <select id="qcount">
             <option value="3">3 — quick round</option>
             <option value="5" selected>5 — classic</option>
             <option value="10">10 — full game</option>
             <option value="15">15 — marathon</option>
             <option value="20">20 — all night</option>
           </select>
           <div class="label" style="margin-top:12px;">Category</div>
           <select id="qcategory">
             <option value="">🎲 Mix of everything</option>
             ${(state.categories || []).map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}
           </select>
         </div>
         <button id="startBtn" ${state.players.length < 2 ? "disabled" : ""}>Start Game${state.players.length < 2 ? " (need 2+)" : ""}</button>`
      : `<div class="waiting">Waiting for the host to start…</div>`}
  `;
  if (isHost()) {
    const sel = document.getElementById("qcount");
    if (lobbyQCount) sel.value = lobbyQCount;
    sel.onchange = () => (lobbyQCount = sel.value);
    const catSel = document.getElementById("qcategory");
    if (lobbyCategory) catSel.value = lobbyCategory;
    catSel.onchange = () => (lobbyCategory = catSel.value);
    document.getElementById("startBtn").onclick = () =>
      socket.emit("startGame", { count: Number(sel.value), category: catSel.value || null });
  }
}

function renderBluff() {
  const waitingOn = state.players.filter((p) => p.connected && !p.submittedLie).map((p) => p.name);
  // The server's copy covers a reload, when the local flag starts over
  const locked = submittedLie || (me() && me().submittedLie);
  // Every state update (a submit, drop or rejoin) rebuilds this screen, so
  // note the cursor in the old lie box to put it back in the new one
  const old = document.getElementById("lie");
  const caret = old && document.activeElement === old ? [old.selectionStart, old.selectionEnd] : null;
  screen.innerHTML = `
    <div class="progress">Question ${state.qNumber} of ${state.qTotal}${state.category ? ` · <span class="cat">${esc(state.category)}</span>` : ""}</div>
    <div class="card">
      <div class="qtext">${esc(state.question)}</div>
      ${locked
        ? `<div class="waiting">Lie locked in 🤫 Waiting on: ${esc(waitingOn.join(", ") || "…")}</div>`
        : `<div class="label">Write a convincing LIE to fill the blank</div>
           <input type="text" id="lie" maxlength="60" placeholder="Your fake answer…" autocomplete="off" />
           <button id="lieBtn">Submit Lie</button>`}
    </div>`;
  if (!locked) {
    const input = document.getElementById("lie");
    input.value = lieDraft;
    input.oninput = () => (lieDraft = input.value);
    if (caret) {
      input.focus();
      input.setSelectionRange(caret[0], caret[1]);
    }
    const submit = () => {
      const lie = document.getElementById("lie").value.trim();
      if (!lie) return showToast("Write something first!");
      socket.emit("submitLie", { lie }, (res) => {
        if (res.ok) {
          submittedLie = true;
          render();
        } else {
          // The real answer earned its bonus but can't be the lie, so clear the box
          if (res.guessedTruth) {
            lieDraft = "";
            render();
          }
          showToast(res.error);
        }
      });
    };
    document.getElementById("lieBtn").onclick = submit;
    document.getElementById("lie").addEventListener("keydown", (e) => e.key === "Enter" && submit());
  }
}

function renderVote() {
  const waitingOn = state.players.filter((p) => p.connected && !p.voted).map((p) => p.name);
  const voted = votedIndex !== null || (me() && me().voted);
  screen.innerHTML = `
    <div class="progress">Question ${state.qNumber} of ${state.qTotal}${state.category ? ` · <span class="cat">${esc(state.category)}</span>` : ""}</div>
    <div class="card">
      <div class="qtext">${esc(state.question)}</div>
      <div class="label">Which one is the TRUTH?</div>
      ${voted
        ? `<div class="waiting">Vote cast 🗳️ Waiting on: ${esc(waitingOn.join(", ") || "…")}</div>`
        : state.choices.map((c) => `<button class="choice" data-i="${c.index}">${esc(c.text)}</button>`).join("")}
    </div>`;
  if (!voted) {
    screen.querySelectorAll(".choice").forEach((btn) => {
      btn.onclick = () => {
        const index = Number(btn.dataset.i);
        socket.emit("submitVote", { index }, (res) => {
          if (res.ok) {
            votedIndex = index;
            render();
          } else {
            showToast(res.error);
          }
        });
      };
    });
  }
}

function renderReveal() {
  const r = state.reveal;
  screen.innerHTML = `
    <div class="progress">Question ${state.qNumber} of ${state.qTotal}${state.category ? ` · <span class="cat">${esc(state.category)}</span>` : ""}</div>
    <div class="card">
      <div class="qtext">${esc(state.question)}</div>
      <div class="label">The truth was</div>
      <div class="truth" style="font-size:1.3rem; margin-bottom:12px;">${esc(r.answer)}</div>
      ${r.truthGuessers && r.truthGuessers.length
        ? `<div class="waiting" style="text-align:left; padding:0 0 10px;">🎯 ${esc(r.truthGuessers.join(", "))} guessed the real answer while bluffing (+500)</div>`
        : ""}
      <ul class="players">
        ${r.results.map((res) => `<li><span>${esc(res.voter)}</span><span>${res.pickedTruth ? '<span class="truth">found the truth! +1000</span>' : `<span class="fooled">fooled by ${esc(res.fooledBy)}</span>`}</span></li>`).join("")}
      </ul>
    </div>
    <div class="card">
      <div class="label">Scores</div>
      <ul class="players">
        ${r.scores.map((s, i) => `<li><span>${i === 0 ? "🏆 " : ""}${esc(s.name)}</span><span>${s.score}</span></li>`).join("")}
      </ul>
    </div>
    ${isHost()
      ? `<button id="nextBtn">${state.qNumber >= state.qTotal ? "Final Results" : "Next Question"}</button>`
      : `<div class="waiting">Waiting for the host…</div>`}
  `;
  if (isHost()) document.getElementById("nextBtn").onclick = () => socket.emit("nextQuestion");
}

function renderGameOver() {
  const scores = [...state.players].sort((a, b) => b.score - a.score);
  screen.innerHTML = `
    <div class="card" style="text-align:center;">
      <div style="font-size:3rem;">🏆</div>
      <div class="truth" style="font-size:1.6rem;">${esc(scores[0].name)} wins!</div>
    </div>
    <div class="card">
      <div class="label">Final scores</div>
      <ul class="players">
        ${scores.map((s, i) => `<li><span>${i + 1}. ${esc(s.name)}</span><span>${s.score}</span></li>`).join("")}
      </ul>
    </div>
    ${isHost()
      ? `<button id="againBtn">Play Again</button>`
      : `<div class="waiting">Waiting for the host…</div>`}
  `;
  if (isHost()) document.getElementById("againBtn").onclick = () => socket.emit("playAgain");
}

renderJoin();
