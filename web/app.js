/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Oasis Dashboard — Client-side Application
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

// ── DOM refs ────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const $clock = $("clock");
const $headerDate = $("header-date");
const $modelName = $("model-name");
const $ctxWindow = $("ctx-window");
const $statusDot = $("status-dot");
const $statusText = $("status-text");
const $navStatusDot = $("nav-status-dot");
const $avatar = $("avatar");
const $messages = $("chat-messages");
const $emptyState = $("empty-state");
const $streamInd = $("streaming-indicator");
const $chatInput = $("chat-input");
const $sendBtn = $("send-btn");
const $clearBtn = $("clear-btn");
const $fillFast = $("fill-fast");
const $fillSlow = $("fill-slow");
const $fillBack = $("fill-back");
const $countFast = $("count-fast");
const $countSlow = $("count-slow");
const $countBack = $("count-back");
const $hbDot = $("heartbeat-dot");
const $hbText = $("heartbeat-text");
const $hbInterval = $("hb-interval");
const $hbSet = $("hb-set");
const $hbOff = $("hb-off");
const $gradeBtn = $("grade-btn");
const $gradeContent = $("grade-content");

// ── State ───────────────────────────────────────────────────────
let ws = null;
let streamingBubble = null;
let streamingBody = null;
let streamAccum = "";

// ── Clock & Date ────────────────────────────────────────────────
function updateClock() {
  const now = new Date();
  $clock.textContent = now.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
  $headerDate.textContent = now.toLocaleDateString("en-US", { day: "numeric", month: "short" });
}
setInterval(updateClock, 1000);
updateClock();

// ── WebSocket ───────────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => console.log("WS connected");

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case "history":
        renderHistory(msg.data);
        break;
      case "status":
        setStatus(msg.data);
        break;
      case "user_message":
        appendMessage("user", msg.data);
        break;
      case "token":
        appendStreamToken(msg.data);
        break;
      case "reply":
        finalizeStream(msg.data);
        break;
      case "error":
        finalizeStream(null);
        appendMessage("error", msg.data);
        break;
    }
  };

  ws.onclose = () => {
    console.log("WS disconnected, reconnecting in 2s…");
    setTimeout(connectWS, 2000);
  };

  ws.onerror = () => ws.close();
}

// ── Status ──────────────────────────────────────────────────────
function setStatus(status) {
  $statusDot.className = "status-dot " + status;
  $statusText.textContent = status;
  $navStatusDot.className = "nav-status-dot " + status;

  if (status === "idle") {
    $avatar.classList.remove("active");
    $streamInd.style.display = "none";
  } else {
    $avatar.classList.add("active");
    if (status === "streaming") {
      $streamInd.style.display = "flex";
    }
  }
}

// ── Messages ────────────────────────────────────────────────────
function hideEmptyState() {
  if ($emptyState) $emptyState.style.display = "none";
}

function renderHistory(history) {
  const existing = $messages.querySelectorAll(".message, .streaming-bubble");
  existing.forEach(m => m.remove());

  if (!history || history.length === 0) {
    if ($emptyState) $emptyState.style.display = "";
    return;
  }

  hideEmptyState();
  for (const msg of history) {
    appendMessage(msg.role, msg.content, false);
  }
}

function appendMessage(role, content, animate = true) {
  hideEmptyState();

  const div = document.createElement("div");
  const isError = role === "error" || (role === "system" && content.includes("Error"));
  const effectiveRole = isError ? "error" : role;

  div.className = `message ${effectiveRole}`;
  if (!animate) div.style.animation = "none";

  const prefixMap = { user: "❯", assistant: "◆", system: "●", error: "✕" };
  const prefix = prefixMap[effectiveRole] || "●";

  div.innerHTML = `
        <span class="msg-prefix ${effectiveRole}">${prefix}</span>
        <span class="msg-body">${escapeHtml(content)}</span>
    `;

  $messages.appendChild(div);
  $messages.scrollTop = $messages.scrollHeight;
}

function appendStreamToken(token) {
  if (!streamingBubble) {
    hideEmptyState();
    streamingBubble = document.createElement("div");
    streamingBubble.className = "streaming-bubble";
    streamingBubble.innerHTML = `
            <span class="msg-prefix assistant">◇</span>
            <span class="msg-body"></span>
        `;
    streamingBody = streamingBubble.querySelector(".msg-body");
    streamAccum = "";
    $messages.appendChild(streamingBubble);
  }

  streamAccum += token;
  streamingBody.textContent = streamAccum;
  $messages.scrollTop = $messages.scrollHeight;
}

function finalizeStream(finalReply) {
  if (streamingBubble) {
    streamingBubble.remove();
    streamingBubble = null;
    streamingBody = null;
    streamAccum = "";
  }

  if (finalReply) {
    appendMessage("assistant", finalReply);
  }
}

function escapeHtml(str) {
  const el = document.createElement("div");
  el.textContent = str;
  return el.innerHTML;
}

// ── Send ────────────────────────────────────────────────────────
function sendMessage() {
  const text = $chatInput.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;

  // Client-side commands
  if (text === "/clear") {
    clearChat();
    $chatInput.value = "";
    return;
  }

  ws.send(JSON.stringify({ type: "chat", message: text }));
  $chatInput.value = "";
}

function clearChat() {
  const msgs = $messages.querySelectorAll(".message, .streaming-bubble");
  msgs.forEach(m => m.remove());
  if ($emptyState) $emptyState.style.display = "";
}

$chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

$sendBtn.addEventListener("click", sendMessage);
$clearBtn.addEventListener("click", clearChat);

// ── Polling status ──────────────────────────────────────────────
async function pollStatus() {
  try {
    const res = await fetch("/api/status");
    if (!res.ok) return;
    const data = await res.json();

    if (data.agent) {
      $modelName.textContent = data.agent.model || "—";
      $ctxWindow.textContent = (data.agent.contextWindow || "—").toLocaleString();
    }

    if (data.queue) {
      updateLane($fillFast, $countFast, data.queue.fast);
      updateLane($fillSlow, $countSlow, data.queue.slow);
      updateLane($fillBack, $countBack, data.queue.background);
    }

    if (data.heartbeat) {
      const hb = data.heartbeat;
      $hbDot.className = "heartbeat-indicator" + (hb.enabled ? " on" : "");
      $hbText.textContent = hb.enabled ? `on · every ${hb.intervalMinutes}m` : "off";
    }
  } catch {
    // silent
  }
}

function updateLane($fill, $count, lane) {
  const total = (lane.pending || 0) + (lane.queued || 0);
  const pct = Math.min(100, total * 25);
  $fill.style.width = pct + "%";
  $count.textContent = total;
}

setInterval(pollStatus, 2000);
pollStatus();

// ── Heartbeat controls ─────────────────────────────────────────
$hbSet.addEventListener("click", async () => {
  const interval = parseInt($hbInterval.value);
  if (!interval || interval < 1) return;

  try {
    await fetch("/api/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", interval }),
    });
    $hbInterval.value = "";
    pollStatus();
  } catch (err) {
    console.error(err);
  }
});

$hbOff.addEventListener("click", async () => {
  try {
    await fetch("/api/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "off" }),
    });
    pollStatus();
  } catch (err) {
    console.error(err);
  }
});

// ── Grade ───────────────────────────────────────────────────────
$gradeBtn.addEventListener("click", async () => {
  $gradeBtn.textContent = "Running…";
  $gradeBtn.disabled = true;

  try {
    const res = await fetch("/api/grade", { method: "POST" });
    const data = await res.json();

    let html = '<div class="grade-result">';
    html += `<div class="grade-overall">${data.report.overall}/100</div>`;
    for (const c of data.report.components) {
      const missing = c.missing.length === 0 ? "none" : c.missing.join(", ");
      html += `<div class="grade-line">${c.component}: ${c.score}/100 · missing: ${missing}</div>`;
    }
    html += '</div>';
    html += '<button class="btn-ghost btn-full" style="margin-top:10px" onclick="this.parentElement.innerHTML=\'<button id=\\\'grade-btn\\\' class=\\\'btn-primary btn-full\\\' onclick=\\\'document.getElementById(\\\\\\\'grade-btn\\\\\\\').click()\\\'>Run Grade Check</button>\'">Close</button>';

    $gradeContent.innerHTML = html;
  } catch {
    $gradeBtn.textContent = "Failed — Retry";
    $gradeBtn.disabled = false;
  }
});

// ── Init ────────────────────────────────────────────────────────
connectWS();
