const socket = io();
const screen = document.getElementById("screen");
const toast = document.getElementById("toast");

let state = null;
let myId = null;
let submittedLie = false;
let votedIndex = null;

socket.on("connect", () => { myId = socket.id; });

socket.on("errorMsg", (msg) => showToast(msg));

socket.on("state", (s) => {
  const phaseChanged = !state || state.phase !== s.phase || state.qNumber !== s.qNumber;
  state = s;
  if (phaseChanged) {
    submittedLie = false;
    votedIndex = null;
  }
  render();
});

function showToast(msg) {
  toast.textContent = msg;
  toast.style.display = "block";
  setTimeout(() => (toast.style.display = "none"), 2500);
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
      if (!res.ok) showToast(res.error);
    });
  };
  document.getElementById("joinBtn").onclick = () => {
    if (!name()) return showToast("Enter your name first!");
    const code = document.getElementById("code").value;
    if (!code) return showToast("Enter the room code!");
    socket.emit("joinRoom", { code, name: name() }, (res) => {
      if (!res.ok) showToast(res.error);
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
      ? `<button id="startBtn" ${state.players.length < 2 ? "disabled" : ""}>Start Game${state.players.length < 2 ? " (need 2+)" : ""}</button>`
      : `<div class="waiting">Waiting for the host to start…</div>`}
  `;
  if (isHost()) document.getElementById("startBtn").onclick = () => socket.emit("startGame");
}

function renderBluff() {
  const waitingOn = state.players.filter((p) => p.connected && !p.submittedLie).map((p) => p.name);
  screen.innerHTML = `
    <div class="progress">Question ${state.qNumber} of ${state.qTotal}</div>
    <div class="card">
      <div class="qtext">${esc(state.question)}</div>
      ${submittedLie
        ? `<div class="waiting">Lie locked in 🤫 Waiting on: ${esc(waitingOn.join(", ") || "…")}</div>`
        : `<div class="label">Write a convincing LIE to fill the blank</div>
           <input type="text" id="lie" maxlength="60" placeholder="Your fake answer…" autocomplete="off" />
           <button id="lieBtn">Submit Lie</button>`}
    </div>`;
  if (!submittedLie) {
    const submit = () => {
      const lie = document.getElementById("lie").value.trim();
      if (!lie) return showToast("Write something first!");
      socket.emit("submitLie", { lie }, (res) => {
        if (res.ok) {
          submittedLie = true;
          render();
        } else {
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
  screen.innerHTML = `
    <div class="progress">Question ${state.qNumber} of ${state.qTotal}</div>
    <div class="card">
      <div class="qtext">${esc(state.question)}</div>
      <div class="label">Which one is the TRUTH?</div>
      ${votedIndex !== null
        ? `<div class="waiting">Vote cast 🗳️ Waiting on: ${esc(waitingOn.join(", ") || "…")}</div>`
        : state.choices.map((c) => `<button class="choice" data-i="${c.index}">${esc(c.text)}</button>`).join("")}
    </div>`;
  if (votedIndex === null) {
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
    <div class="progress">Question ${state.qNumber} of ${state.qTotal}</div>
    <div class="card">
      <div class="qtext">${esc(state.question)}</div>
      <div class="label">The truth was</div>
      <div class="truth" style="font-size:1.3rem; margin-bottom:12px;">${esc(r.answer)}</div>
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
