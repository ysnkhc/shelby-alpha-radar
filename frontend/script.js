// ── Config ───────────────────────────────────────────────────
const API_BASE =
  window.location.hostname === "localhost"
    ? "http://localhost:3000"
    : "https://shelby-alpha-radar-production.up.railway.app";

// ── State ────────────────────────────────────────────────────
const MAX_EVENTS = 100;
let allEvents = [];
let currentFilter = "ALL";
let eventSource = null;
let stats = { total: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
const timelineCache = new Map();

// ── SSE ──────────────────────────────────────────────────────
function connect() {
  eventSource = new EventSource(`${API_BASE}/ws/alpha`);
  eventSource.addEventListener("connected", (e) => {
    const d = JSON.parse(e.data);
    setStatus("connected", `Live — ${d.clients} client${d.clients !== 1 ? "s" : ""}`);
  });
  eventSource.addEventListener("backfill", (e) => {
    const d = JSON.parse(e.data);
    if (d.events?.length) {
      d.events.forEach((ev) => addEvent(ev, false));
      renderFeed();
    }
  });
  eventSource.addEventListener("alpha", (e) => {
    addEvent(JSON.parse(e.data), true);
    renderFeed();
  });
  eventSource.onerror = () => {
    setStatus("disconnected", "Reconnecting...");
    setTimeout(() => {
      eventSource?.close();
      connect();
    }, 3000);
  };
}

// ── Events ───────────────────────────────────────────────────
function addEvent(event, prepend) {
  if (!event.impact) {
    event.impact = IMPACT_MAP[event.signalType] || "";
    event.context = event.context || "";
  }
  if (!event.priority) event.priority = inferPriority(event.score, event.signalType);
  stats.total++;
  if (event.priority in stats) stats[event.priority]++;
  updateStats();
  if (prepend) allEvents.unshift(event);
  else allEvents.push(event);
  if (allEvents.length > MAX_EVENTS) allEvents = allEvents.slice(0, MAX_EVENTS);
}

const IMPACT_MAP = {
  CROSS_WALLET_PATTERN:
    "Multiple wallets acting together may indicate shared pipelines, coordinated uploads, or automated distribution systems",
  WALLET_VELOCITY:
    "Sudden velocity spikes may indicate automated scripts, bot activity, or large-scale data migration",
  FIRST_TIME_BURST:
    "First-time burst activity suggests automated pipelines, airdrop claims, or programmatic uploads",
  DORMANT_REACTIVATION:
    "Returning wallets may indicate renewed interest, delayed workflows, or reactivated automation",
  RARE_FILE_TYPE:
    "New file types may represent new use cases, protocol experiments, or novel data formats",
};

function updateStats() {
  document.getElementById("statTotal").textContent = stats.total;
  document.getElementById("statHigh").textContent = stats.HIGH;
  document.getElementById("statMedium").textContent = stats.MEDIUM;
  document.getElementById("statLow").textContent = stats.LOW;
}

// ── Rendering ────────────────────────────────────────────────
function renderFeed() {
  const feed = document.getElementById("feed");
  let filtered =
    currentFilter === "ALL" ? allEvents : allEvents.filter((e) => e.priority === currentFilter);

  filtered.sort((a, b) => {
    if (a.priority === "HIGH" && b.priority !== "HIGH") return -1;
    if (b.priority === "HIGH" && a.priority !== "HIGH") return 1;
    return new Date(b.timestamp) - new Date(a.timestamp);
  });

  document.getElementById("eventCount").textContent = `${filtered.length} event${filtered.length !== 1 ? "s" : ""}`;

  if (!filtered.length) {
    feed.innerHTML = `<div class="feed-empty"><div class="feed-empty-icon">📡</div><div>Waiting for signals...</div><div class="feed-empty-text">High-signal events will appear here in real-time</div></div>`;
    return;
  }

  const { groups, singles } = groupSignals(filtered);
  let html = "";
  groups.forEach((g) => { html += renderGroupCard(g); });
  singles.forEach((ev) => { html += renderCard(ev); });
  feed.innerHTML = html;

  singles.forEach((ev) => {
    if (!timelineCache.has(ev.owner)) loadTimeline(ev.owner);
  });
}

// ── Grouping ─────────────────────────────────────────────────
function groupSignals(events) {
  const crossWallet = [];
  const rest = [];

  events.forEach((e) => {
    if (e.signalType === "CROSS_WALLET_PATTERN") crossWallet.push(e);
    else rest.push(e);
  });

  const cwByType = new Map();
  crossWallet.forEach((e) => {
    const match = e.explanation.match(/\.(\w+)\s+files/);
    const ext = match ? match[1] : "unknown";
    if (!cwByType.has(ext)) cwByType.set(ext, []);
    cwByType.get(ext).push(e);
  });

  const groups = [];
  const ungrouped = [];

  cwByType.forEach((evts, ext) => {
    if (evts.length >= 2) {
      const totalWallets = new Set();
      let maxScore = 0;
      evts.forEach((e) => {
        const m = e.explanation.match(/(\d+)\s+wallets/);
        if (m) for (let i = 0; i < parseInt(m[1]); i++) totalWallets.add(`${e.owner}_${i}`);
        if (e.score > maxScore) maxScore = e.score;
      });
      const walletCount = totalWallets.size || evts.length * 3;
      const oldest = new Date(Math.min(...evts.map((e) => new Date(e.timestamp))));
      const newest = new Date(Math.max(...evts.map((e) => new Date(e.timestamp))));
      const spanMin = Math.max(1, Math.round((newest - oldest) / 60000));

      const mid = evts.length / 2;
      const recentScores = evts.slice(0, Math.ceil(mid));
      const olderScores = evts.slice(Math.ceil(mid));
      let trend = "steady";
      if (recentScores.length && olderScores.length) {
        const avgRecent = recentScores.reduce((s, e) => s + e.score, 0) / recentScores.length;
        const avgOlder = olderScores.reduce((s, e) => s + e.score, 0) / olderScores.length;
        if (avgRecent > avgOlder * 1.2) trend = "up";
        else if (avgRecent < avgOlder * 0.8) trend = "down";
      }

      groups.push({ ext, events: evts, walletCount, maxScore, spanMin, trend, count: evts.length });
    } else {
      ungrouped.push(...evts);
    }
  });

  return { groups, singles: [...ungrouped, ...rest] };
}

function renderGroupCard(g) {
  const trendIcon = g.trend === "up" ? "↑" : g.trend === "down" ? "↓" : "→";
  const trendClass = g.trend === "up" ? "trend-up" : g.trend === "down" ? "trend-down" : "trend-steady";
  return `
    <div class="group-card">
      <div class="group-header">
        <span class="group-badge">Grouped</span>
        <span class="group-title">${g.walletCount} wallets uploaded .${esc(g.ext)} in last ${g.spanMin} min</span>
        <span class="group-count">${g.count} signals</span>
      </div>
      <div class="group-context">Coordinated pattern across ${g.count} detections · max score: ${g.maxScore}</div>
      <div class="group-trend ${trendClass}">Trend: ${trendIcon} ${g.trend} activity</div>
    </div>`;
}

function renderCard(event) {
  const timeAgo = getTimeAgo(new Date(event.timestamp));
  const typeLabel = event.signalType.replace(/_/g, " ");
  const isExtreme = event.score >= 9;
  const extremeClass = isExtreme ? " extreme" : "";
  const strongLabel = isExtreme ? '<span class="strong-label">🔥 Strong Signal</span>' : "";
  const timeline = timelineCache.get(event.owner);
  const timelineHtml = timeline ? renderTimeline(timeline) : "";
  const impactHtml = event.impact
    ? `<div class="signal-impact">
        <div class="signal-impact-label">💡 Why this matters</div>
        ${esc(event.impact)}
      </div>`
    : "";
  const contextHtml = event.context ? `<div class="signal-context">📊 ${esc(event.context)}</div>` : "";

  return `
    <div class="signal-card priority-${event.priority}${extremeClass}">
      <div class="signal-header">
        <span class="priority-badge ${event.priority}">${event.priority}</span>
        ${strongLabel}
        <span class="signal-type">${typeLabel}</span>
        <span class="signal-score ${event.priority}">${event.score}</span>
      </div>
      <div class="signal-explanation">${esc(event.explanation)}</div>
      ${impactHtml}
      ${contextHtml}
      <div class="signal-meta">
        <span class="signal-meta-item">👤 ${event.ownerShort || shorten(event.owner)}</span>
        <span class="signal-meta-item">🕐 ${timeAgo}</span>
        ${event.blobName ? `<span class="signal-meta-item">📄 ${esc(truncate(event.blobName, 28))}</span>` : ""}
      </div>
      ${timelineHtml}
    </div>`;
}

function renderTimeline(tl) {
  if (!tl.length) return "";
  const items = tl
    .slice(0, 3)
    .map(
      (t) =>
        `<div class="timeline-item">
      <div class="timeline-dot"></div>
      <span class="timeline-type">${esc(t.fileType || "?")}</span>
      <span>${esc(truncate(t.fileName, 20))}</span>
      <span class="timeline-time">${t.timeAgo}</span>
    </div>`
    )
    .join("");
  return `<div class="mini-timeline"><div class="timeline-header">Recent activity</div><div class="timeline-items">${items}</div></div>`;
}

// ── Timeline loader ──────────────────────────────────────────
async function loadTimeline(owner) {
  if (timelineCache.has(owner)) return;
  timelineCache.set(owner, []);
  try {
    const r = await fetch(`${API_BASE}/owners/${owner}/timeline?limit=3`);
    if (r.ok) {
      const d = await r.json();
      timelineCache.set(owner, d.timeline || []);
      renderFeed();
    }
  } catch (_) {}
}

// ── Filters ──────────────────────────────────────────────────
function setFilter(f) {
  currentFilter = f;
  document.querySelectorAll(".filter-btn").forEach((b) => (b.className = "filter-btn"));
  const btn = document.getElementById("filter" + capitalize(f));
  if (f === "HIGH") btn.classList.add("active");
  else if (f === "MEDIUM") btn.classList.add("active-medium");
  else btn.classList.add("active-all");
  renderFeed();
}

function setStatus(state, text) {
  document.getElementById("statusDot").className = "status-dot" + (state === "connected" ? " connected" : "");
  document.getElementById("statusText").textContent = text;
}

// ── Helpers ──────────────────────────────────────────────────
function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
function truncate(s, l) { return s.length > l ? s.slice(0, l) + "…" : s; }
function shorten(a) { return a ? `${a.slice(0, 8)}...${a.slice(-4)}` : ""; }
function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); }
function getTimeAgo(d) {
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}
function inferPriority(score, type) {
  const boosted = ["CROSS_WALLET_PATTERN", "WALLET_VELOCITY"];
  if (score >= 8 || (score >= 6 && boosted.includes(type))) return "HIGH";
  if (score >= 6) return "MEDIUM";
  return "LOW";
}

setInterval(() => {
  if (allEvents.length) renderFeed();
}, 30000);

// ── Load history from REST API ───────────────────────────────
async function loadHistory() {
  try {
    const r = await fetch(`${API_BASE}/alpha?limit=50`);
    const d = await r.json();
    if (d.events?.length) {
      d.events.forEach((e) => {
        e.impact = e.impact || IMPACT_MAP[e.signalType] || "";
        e.context = e.context || "";
        e.priority = e.priority || inferPriority(e.score, e.signalType);
        addEvent(e, false);
      });
      allEvents.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      renderFeed();
    }
  } catch (_) {}
}

// ── Init ─────────────────────────────────────────────────────
loadHistory();
connect();
