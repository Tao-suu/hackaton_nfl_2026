"use strict";

/* ================================================================
   NFL Play Analyzer — frontend logic
   Canvas field rendering + frame animation + openness overlay
   ================================================================ */

// ---- field constants (yards) ----
const FIELD_W = 120;          // 0-120 incl. end zones
const FIELD_H = 53.3;
const EZ_W = 10;              // end zone width
const CANVAS_W = 1000;
const CANVAS_H = Math.round(CANVAS_W * (FIELD_H / FIELD_W)); // 444
const SCALE = CANVAS_W / FIELD_W;   // px per yard ≈ 8.33

// ---- NFL team colors ----
const TEAM_COLORS = {
  ARI: "#97233F", ATL: "#A71930", BAL: "#241773", BUF: "#00338D",
  CAR: "#0085CA", CHI: "#0B162A", CIN: "#FB4F14", CLE: "#311D00",
  DAL: "#003594", DEN: "#FB4F14", DET: "#0076B6", GB:  "#203731",
  HOU: "#03202F", IND: "#002C5F", JAX: "#101820", KC:  "#E31837",
  LAC: "#0080C5", LAR: "#003594", LV:  "#242424", MIA: "#008E97",
  MIN: "#4F2683", NE:  "#002244", NO:  "#9F8958", NYG: "#0B2267",
  NYJ: "#125740", PHI: "#004C54", PIT: "#FFB612", SF:  "#AA0000",
  SEA: "#002244", TB:  "#D50A0A", TEN: "#0C2340", WAS: "#5A1414",
};

// ---- state ----
const state = {
  games: [],
  plays: [],
  playData: null,
  simData: null,          // pass options currently shown (at throw or at a chosen frame)
  optionsBase: null,      // pass options at the throw + timeline + precision
  weights: { completion: 35, conversion: 25, gain: 25, safety: 15 },
  weightsTouched: false,
  qbProfile: null,
  currentFrame: 0,
  isPlaying: false,
  playSpeed: 1,
  rafId: null,
  lastTick: 0,
  scrimmageX: null,
  firstDownX: null,
  selectedReceiverId: null, // receiver picked for what-if
  keyMoments: [],         // chess-style key frames
  // zoom / pan (view transform in canvas px)
  zoom: 1,
  panX: 0,
  panY: 0,
  isPanning: false,
  panStart: null,
  viewScale: 1,           // logical px → backing-store px (CSS size × devicePixelRatio)
  lastLayout: null,       // last computed marker layout (for hit-testing)
};

const MIN_ZOOM = 1;
const MAX_ZOOM = 6;

// ---- DOM refs ----
const $ = (id) => document.getElementById(id);
const canvas = $("field");
const ctx = canvas.getContext("2d");

/* ================================================================
   API
   ================================================================ */

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`API ${r.status}`);
  return r.json();
}

async function loadGames() {
  state.games = await fetchJSON("/api/games");
  const sel = $("game-select");
  sel.innerHTML = "";
  state.games.forEach((g) => {
    const o = document.createElement("option");
    o.value = g.gameId;
    o.textContent = g.label;
    sel.appendChild(o);
  });
  if (state.games.length > 0) {
    await loadPlays(state.games[0].gameId);
  }
}

async function loadPlays(gameId) {
  state.plays = await fetchJSON(`/api/plays/${gameId}`);
  state.timingLabels = {};
  filterAndRenderPlays();
  // timing verdicts for the whole game (computed server-side, ~3 s first time)
  try {
    state.timingLabels = await fetchJSON(`/api/timing-labels/${gameId}`);
    applyTimingLabelsToOptions();
  } catch (e) { console.error("timing labels failed", e); }
}

const TIMING_TAG = {
  dans_les_temps: "✅ dans les temps",
  fenetre_manquee: "🟠 fenêtre manquée",
  receveurs_en_retard: "🔴 receveurs en retard",
  couverture_gagnante: "⚪ couverture gagnante",
};

function applyTimingLabelsToOptions() {
  const labels = state.timingLabels || {};
  for (const o of $("play-select").options) {
    if (!o.dataset.base) o.dataset.base = o.textContent;
    const tag = TIMING_TAG[labels[o.value]];
    o.textContent = tag ? `${tag} | ${o.dataset.base}` : o.dataset.base;
  }
}

function filterAndRenderPlays() {
  // pass plays only (complete, incomplete, interception)
  const plays = state.plays.filter((p) => p.isPass);

  const sel = $("play-select");
  sel.innerHTML = "";
  plays.forEach((p, i) => {
    const o = document.createElement("option");
    o.value = p.playId;
    const dn = p.down ? `${p.down}${["th","st","nd","rd"][Math.min(p.down,3)]}` : "";
    const res = p.passResult ? ` [${p.passResult}]` : "";
    o.textContent = `${dn} & ${p.yardsToGo}  —${res}  ${p.description.substring(0, 55)}`;
    sel.appendChild(o);
  });
  applyTimingLabelsToOptions();
  if (plays.length > 0) {
    loadPlay(gameIdFromSelect(), parseInt(sel.value));
  } else {
    state.playData = null;
    render();
    $("play-info-panel").style.display = "none";
    for (const id of ["openness-panel", "sim-panel", "precision-panel", "decision-panel", "timing-panel"]) {
      $(id).style.display = "none";
    }
  }
}

async function loadPlay(gameId, playId) {
  state.isPlaying = false;
  $("btn-play").textContent = "▶";
  state.selectedReceiverId = null;
  state.simData = null;
  state.optionsBase = null;
  state.qbProfile = null;
  for (const id of ["sim-panel", "precision-panel", "decision-panel"]) $(id).style.display = "none";
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  updateZoomButtons();
  try {
    state.playData = await fetchJSON(`/api/play/${gameId}/${playId}`);
  } catch (e) {
    console.error(e);
    state.playData = null;
  }
  state.currentFrame = 0;

  // compute line of scrimmage & first down from snap frame ball position
  if (state.playData && state.playData.frames.length) {
    const f0 = state.playData.frames[0];
    if (f0.ball) {
      state.scrimmageX = f0.ball.x;
      const ytg = state.playData.playInfo.yardsToGo || 10;
      state.firstDownX = state.scrimmageX + ytg;
    }
  }

  state.timing = null;
  renderTimingPanel();
  buildKeyMoments();
  updateUI();
  render();

  // load simulation + timing metric in the background (don't block the animation)
  loadOptions(gameId, playId);
  loadTiming(gameId, playId);
}

/* ---- Timing Delta (compute_timing.py) ---- */
async function loadTiming(gameId, playId) {
  try {
    const t = await fetchJSON(`/api/timing/${gameId}/${playId}`);
    // ignore late responses for a play we already left
    if (!state.playData || state.playData.playInfo.playId !== playId) return;
    state.timing = t;
  } catch (e) {
    console.error("timing failed", e);
    state.timing = null;
  }
  buildKeyMoments();
  renderTimingPanel();
  renderDecision(); // uses "hold after open"
  render();
}

const TIMING_VERDICTS = {
  dans_les_temps: { cls: "tv-good", title: "Dans les temps",
    text: "A receiver got open and the ball was out before pressure arrived." },
  fenetre_manquee: { cls: "tv-closing", title: "Fenêtre manquée",
    text: "A receiver got open first, but the QB held the ball until pressure arrived. Not necessarily the QB's fault: that receiver may not have been in his read." },
  receveurs_en_retard: { cls: "tv-late", title: "Receveurs en retard",
    text: "Pressure reached the QB before any receiver got open." },
  couverture_gagnante: { cls: "tv-cover", title: "Couverture gagnante",
    text: "Nobody reached 3 yds of separation and no pressure: the QB threw into a tight window." },
  non_calculable: { cls: "tv-cover", title: "Non calculable",
    text: "No usable snap or ball position on this play." },
};

const TIMING_STATES = {
  avant_snap: { cls: "ts-dim", text: "PRE-SNAP" },
  en_developpement: { cls: "ts-neutral", text: "DEVELOPING" },
  receveur_ouvert: { cls: "ts-open", text: "RECEIVER OPEN · THROW WINDOW" },
  pression_apres_ouverture: { cls: "ts-closing", text: "PRESSURE · WINDOW CLOSING" },
  pression_avant_ouverture: { cls: "ts-late", text: "PRESSURE BEFORE ANYONE OPEN" },
  apres_fin: { cls: "ts-dim", text: "POCKET TIME OVER" },
};

function fmtS(v, signed) {
  if (v == null) return "—";
  return `${signed && v > 0 ? "+" : ""}${v.toFixed(1)}s`;
}

function renderTimingPanel() {
  const t = state.timing;
  if (!t) { $("timing-panel").style.display = "none"; return; }
  $("timing-panel").style.display = "";

  const v = TIMING_VERDICTS[t.label] || TIMING_VERDICTS.non_calculable;
  const name = (id) => {
    if (id == null || !state.playData) return null;
    const p = state.playData.frames[0].players.find((x) => x.nflId === id);
    return p ? p.name : `#${id}`;
  };
  const opener = name(t.firstOpenId);
  $("timing-verdict").innerHTML = `
    <div class="tv-badge ${v.cls}">${v.title}</div>
    <div>${v.text}${opener ? ` First open: <b>${opener}</b>.` : ""}</div>`;

  // timeline from snap to max(end, pressure) + a bit
  const max = Math.max(t.tEnd || 0, t.tPressure || 0, t.tOpen || 0, 1) * 1.15;
  state.timingAxisMax = max;
  const place = (id, val) => {
    const el = $(id);
    if (val == null) { el.style.display = "none"; return; }
    el.style.display = "";
    el.style.left = `${Math.min(100, (val / max) * 100)}%`;
    el.title = `${val.toFixed(1)}s after snap`;
  };
  place("tm-open", t.tOpen);
  place("tm-pressure", t.tPressure);
  place("tm-end", t.tEnd);
  $("tm-axis-max").textContent = `${max.toFixed(1)}s`;

  const deltaCls = t.delta == null ? "" : t.delta > 0 ? "good" : "bad";
  $("timing-stats").innerHTML = `
    <div class="stat"><div class="stat-label">t_open</div><div class="stat-val">${fmtS(t.tOpen)}</div></div>
    <div class="stat"><div class="stat-label">t_pressure</div><div class="stat-val">${fmtS(t.tPressure)}</div></div>
    <div class="stat"><div class="stat-label">Timing Δ</div><div class="stat-val ${deltaCls}">${fmtS(t.delta, true)}</div></div>
    <div class="stat"><div class="stat-label">Hold after open</div><div class="stat-val">${fmtS(t.holdAfterOpen)}</div></div>`;
  updateTimingLive();
}

// called every render: banner on the field + cursor on the timeline
function updateTimingLive() {
  const banner = $("timing-banner");
  const t = state.timing;
  const frame = state.playData && state.playData.frames[state.currentFrame];
  if (!t || !frame || !t.frames[frame.frameId]) {
    banner.className = "ts-none"; banner.textContent = ""; return;
  }
  const f = t.frames[frame.frameId];
  const s = TIMING_STATES[f.state];
  if (!s) { banner.className = "ts-none"; banner.textContent = ""; return; }
  banner.className = s.cls;
  banner.textContent = f.t != null && f.state !== "avant_snap"
    ? `${s.text} · ${f.t.toFixed(1)}s` : s.text;

  const cur = $("tm-cursor");
  if (f.t == null || f.t < 0 || !state.timingAxisMax) { cur.style.display = "none"; return; }
  cur.style.display = "";
  cur.style.left = `${Math.min(100, (f.t / state.timingAxisMax) * 100)}%`;
}


/* ---- chess.com-style key moments ---- */
function buildKeyMoments() {
  state.keyMoments = [];
  if (!state.playData) return;
  const frames = state.playData.frames;
  const EVENT_MOMENTS = {
    ball_snap: { label: "Snap", cls: "snap" },
    pass_forward: { label: "Throw", cls: "throw" },
    pass_arrived: { label: "Arrival", cls: "throw" },
    pass_outcome_caught: { label: "Caught", cls: "good" },
    pass_outcome_touchdown: { label: "TD", cls: "good" },
    pass_outcome_incomplete: { label: "Incomplete", cls: "bad" },
    pass_outcome_interception: { label: "INT", cls: "bad" },
    tackle: { label: "Tackle", cls: "bad" },
    out_of_bounds: { label: "Out", cls: "bad" },
    quarterback_sack: { label: "Sack", cls: "bad" },
    fumble: { label: "Fumble", cls: "bad" },
  };
  // always include the start
  state.keyMoments.push({ frameId: frames[0].frameId, label: "Start", cls: "", idx: 0 });
  frames.forEach((f, idx) => {
    if (f.event && EVENT_MOMENTS[f.event]) {
      const m = EVENT_MOMENTS[f.event];
      state.keyMoments.push({ frameId: f.frameId, label: m.label, cls: m.cls, idx });
    }
  });
  // Timing Delta moments: first receiver open, first pressure
  const t = state.timing;
  if (t) {
    const add = (frameId, label, cls) => {
      if (frameId == null) return;
      const idx = frames.findIndex((f) => f.frameId === frameId);
      if (idx >= 0) state.keyMoments.push({ frameId, label, cls, idx });
    };
    add(t.openFrame, "Open", "open");
    add(t.pressureFrame, "Pressure", "pressure");
  }
  // best window of the play (multi-criteria peak)
  const ser = typeof decisionSeries === "function" ? decisionSeries() : null;
  if (ser) {
    const idx = frames.findIndex((f) => f.frameId === ser.peak.frameId);
    if (idx >= 0) state.keyMoments.push({ frameId: ser.peak.frameId, label: "Best window", cls: "good", idx });
  }
  state.keyMoments.sort((a, b) => a.idx - b.idx);
  renderMoves();
}

function renderMoves() {
  const track = $("moves-track");
  track.innerHTML = "";
  state.keyMoments.forEach((m) => {
    const chip = document.createElement("div");
    chip.className = `move-chip ${m.cls}`;
    const t = (m.idx * 0.1).toFixed(1);
    chip.innerHTML = `<span class="move-label">${m.label}</span><span class="move-time">${t}s</span>`;
    chip.addEventListener("click", () => {
      state.isPlaying = false;
      $("btn-play").textContent = "▶";
      if (state.rafId) cancelAnimationFrame(state.rafId);
      state.currentFrame = m.idx;
      updateFrameLabel();
      updateOpennessList();
      renderMoves();
      render();
    });
    track.appendChild(chip);
  });
  highlightActiveMove();
}

function highlightActiveMove() {
  const chips = $("moves-track").children;
  // find the latest moment whose idx <= currentFrame
  let activeI = 0;
  state.keyMoments.forEach((m, i) => {
    if (m.idx <= state.currentFrame) activeI = i;
  });
  for (let i = 0; i < chips.length; i++) {
    chips[i].classList.toggle("active", i === activeI);
  }
}

function jumpToMove(delta) {
  if (!state.keyMoments.length) return;
  let activeI = 0;
  state.keyMoments.forEach((m, i) => {
    if (m.idx <= state.currentFrame) activeI = i;
  });
  const next = Math.max(0, Math.min(state.keyMoments.length - 1, activeI + delta));
  state.isPlaying = false;
  $("btn-play").textContent = "▶";
  if (state.rafId) cancelAnimationFrame(state.rafId);
  state.currentFrame = state.keyMoments[next].idx;
  updateFrameLabel();
  updateOpennessList();
  renderMoves();
  render();
}

/* ================================================================
   Canvas rendering
   ================================================================ */

/* ---- view helpers ----
   The field (grass, lines, numbers) is drawn inside the zoom transform, so it
   scales. Players, rings and labels are drawn in SCREEN space at positions
   computed from the zoom, with sizes that barely grow. Zooming therefore
   spreads players apart instead of just making the circles bigger. */

// players closer than this (in yards) are physically engaged (block, tackle…)
// and are allowed to overlap; everyone else gets shrunk so they don't stack.
const CONTACT_YDS = 0.9;
const BASE_R = 11;   // marker radius (logical px) when there is room
const MIN_R = 4;     // smallest marker radius when crowded

// field yards → logical screen px (after zoom/pan)
function sx(xYd) { return state.panX + xYd * SCALE * state.zoom; }
function sy(yYd) { return state.panY + yYd * SCALE * state.zoom; }

// markers grow only slightly with zoom (≈ zoom^0.3, capped)
function uiScale() { return Math.min(1.6, Math.pow(state.zoom, 0.3)); }

function yToPx(y) { return y * SCALE; }
function xToPx(x) { return x * SCALE; }

function opennessColor(d) {
  return lerpColor("#f85149", "#3fb950", Math.min(d / 8, 1));
}

/* ---- main render ---- */
function render() {
  ctx.setTransform(state.viewScale, 0, 0, state.viewScale, 0, 0);
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

  // field layer (scales with zoom)
  ctx.save();
  ctx.translate(state.panX, state.panY);
  ctx.scale(state.zoom, state.zoom);
  drawField();
  if (state.playData) drawLineOfScrimmage();
  ctx.restore();

  if (!state.playData) {
    ctx.fillStyle = "#8b949e";
    ctx.font = "18px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Select a play to begin", CANVAS_W / 2, CANVAS_H / 2);
    return;
  }

  const frame = state.playData.frames[state.currentFrame];
  if (!frame) return;

  // marker layer (screen space, collision-aware)
  const layout = computeLayout(frame);
  state.lastLayout = layout;
  drawOpennessLines(frame, layout);
  drawPlayers(layout);
  drawBall(frame, layout);
  drawRings(frame, layout);
  drawLabels(frame, layout);

  // overlays
  drawEventBadge(frame);
  drawZoomIndicator();
  updateTimingLive();
  // keep the decision chart cursor in sync with the animation
  const ser = state.optionsBase ? decisionSeries() : null;
  if (ser) drawDecisionChart(ser);
}

/* ---- layout: adaptive radius so markers only overlap on real contact ---- */
function computeLayout(frame) {
  const k = uiScale();
  const baseR = BASE_R * k;
  const nodes = frame.players.map((p) => ({
    p, x: sx(p.x), y: sy(p.y), r: baseR, inContact: false,
  }));

  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    let nearest = Infinity;
    for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue;
      const b = nodes[j];
      const yd = Math.hypot(a.p.x - b.p.x, a.p.y - b.p.y);
      if (yd < CONTACT_YDS) { a.inContact = true; continue; } // allowed to stack
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < nearest) nearest = d;
    }
    // half the gap to the nearest non-contact neighbour (minus a hairline)
    a.r = Math.max(MIN_R, Math.min(baseR, nearest / 2 - 0.75));
  }

  const byId = new Map(nodes.map((n) => [n.p.nflId, n]));
  return { nodes, byId, k, baseR };
}

/* ---- field ---- */
function drawField() {
  const lw = 1 / state.zoom; // keep line widths constant on screen

  // end zones
  ctx.fillStyle = "#0d2818";
  ctx.fillRect(0, 0, xToPx(EZ_W), CANVAS_H);
  ctx.fillRect(xToPx(FIELD_W - EZ_W), 0, xToPx(EZ_W), CANVAS_H);

  // playing field
  ctx.fillStyle = "#1a472a";
  ctx.fillRect(xToPx(EZ_W), 0, xToPx(FIELD_W - 2 * EZ_W), CANVAS_H);

  // end zone labels
  if (state.playData) {
    const pi = state.playData.playInfo;
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.font = "bold 16px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.save();
    ctx.translate(xToPx(5), CANVAS_H / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(pi.visitorTeamAbbr || "END", 0, 0);
    ctx.restore();
    ctx.save();
    ctx.translate(xToPx(FIELD_W - 5), CANVAS_H / 2);
    ctx.rotate(Math.PI / 2);
    ctx.fillText(pi.homeTeamAbbr || "END", 0, 0);
    ctx.restore();
  }

  // yard lines every 5 yards (+ every yard when zoomed in a lot)
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = lw;
  for (let yd = EZ_W; yd <= FIELD_W - EZ_W; yd += 5) {
    const px = xToPx(yd);
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, CANVAS_H);
    ctx.stroke();
  }
  if (state.zoom >= 3) {
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    for (let yd = EZ_W; yd <= FIELD_W - EZ_W; yd++) {
      if (yd % 5 === 0) continue;
      const px = xToPx(yd);
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, CANVAS_H);
      ctx.stroke();
    }
  }

  // yard numbers
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.font = "bold 13px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let yd = 20; yd <= FIELD_W - 20; yd += 10) {
    const num = yd <= 60 ? yd - EZ_W : FIELD_W - EZ_W - yd;
    const label = String(num);
    ctx.fillText(label, xToPx(yd), 18);
    ctx.fillText(label, xToPx(yd), CANVAS_H - 18);
  }

  // hash marks
  ctx.strokeStyle = "rgba(255,255,255,0.2)";
  ctx.lineWidth = lw;
  const h1 = yToPx(23.57);
  const h2 = yToPx(29.73);
  for (let yd = EZ_W; yd <= FIELD_W - EZ_W; yd++) {
    if (yd % 5 === 0) continue;
    const px = xToPx(yd);
    ctx.beginPath();
    ctx.moveTo(px, h1 - 4); ctx.lineTo(px, h1 + 4);
    ctx.moveTo(px, h2 - 4); ctx.lineTo(px, h2 + 4);
    ctx.stroke();
  }

  // border
  ctx.strokeStyle = "rgba(255,255,255,0.6)";
  ctx.lineWidth = 2 * lw;
  ctx.strokeRect(0, 0, CANVAS_W, CANVAS_H);
}

function drawLineOfScrimmage() {
  if (state.scrimmageX == null) return;
  const lw = 2 / state.zoom;
  // line of scrimmage — blue
  ctx.strokeStyle = "rgba(86,166,255,0.7)";
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.moveTo(xToPx(state.scrimmageX), 0);
  ctx.lineTo(xToPx(state.scrimmageX), CANVAS_H);
  ctx.stroke();

  // first down line — yellow
  if (state.firstDownX != null) {
    const fx = xToPx(Math.min(state.firstDownX, FIELD_W));
    ctx.strokeStyle = "rgba(255,215,0,0.7)";
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(fx, 0);
    ctx.lineTo(fx, CANVAS_H);
    ctx.stroke();
  }
}

/* ---- markers ---- */
function drawPlayers(layout) {
  // defense first, offense on top, selected receiver last
  const order = [...layout.nodes].sort((a, b) => {
    const rank = (n) => (n.p.nflId === state.selectedReceiverId ? 2 : n.p.isOffense ? 1 : 0);
    return rank(a) - rank(b);
  });
  for (const n of order) drawPlayer(n);
}

function drawPlayer(n) {
  const p = n.p;
  const color = TEAM_COLORS[p.team] || "#555";

  ctx.fillStyle = color;
  ctx.strokeStyle = p.isOffense ? "#fff" : "#000";
  ctx.lineWidth = Math.max(1, 1.5 * (n.r / BASE_R));
  ctx.beginPath();
  ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // jersey number only when the marker is big enough to read it
  if (n.r >= 6.5) {
    ctx.fillStyle = isLightColor(color) ? "#000" : "#fff";
    ctx.font = `bold ${Math.round(n.r * 0.95)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(p.jersey), n.x, n.y + 0.5);
  }
}

function drawBall(frame, layout) {
  if (!frame.ball) return;
  const k = layout.k;
  ctx.fillStyle = "#8B4513";
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.ellipse(sx(frame.ball.x), sy(frame.ball.y), 5 * k, 3.3 * k, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

function drawOpennessLines(frame, layout) {
  ctx.save();
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  for (const rec of frame.receivers) {
    if (rec.nearestDefenderX == null) continue;
    ctx.strokeStyle = opennessColor(rec.openness);
    ctx.beginPath();
    ctx.moveTo(sx(rec.x), sy(rec.y));
    ctx.lineTo(sx(rec.nearestDefenderX), sy(rec.nearestDefenderY));
    ctx.stroke();
  }
  ctx.restore();
}

function ring(n, extra, color, width) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(n.x, n.y, n.r + extra, 0, Math.PI * 2);
  ctx.stroke();
}

function drawRings(frame, layout) {
  const a = state.playData.analysis;
  const afterThrow = a && a.hasPass && frame.frameId >= a.passForwardFrame;

  // openness ring on every receiver
  for (const rec of frame.receivers) {
    const n = layout.byId.get(rec.nflId);
    if (n) ring(n, 2.5, opennessColor(rec.openness), 2);
  }
  // actual target after the throw, best multi-criteria option from the evaluated frame
  const extra = 6;
  const targetId = afterThrow && a.target ? a.target.nflId : null;
  if (targetId) {
    const n = layout.byId.get(targetId);
    if (n) ring(n, extra, "#d29922", 2.5);
  }
  const bestId = frame.frameId >= bestVisibleFrom() ? bestOptionId() : null;
  if (bestId) {
    const n = layout.byId.get(bestId);
    if (n) ring(n, bestId === targetId ? extra + 4 : extra, "#3fb950", 2.5);
  }
  // Timing Delta: receivers "open" by the metric (green halo) and
  // defenders pressuring the QB (red halo)
  const tf = state.timing && state.timing.frames[frame.frameId];
  if (tf) {
    for (const id of tf.openIds) {
      const n = layout.byId.get(id);
      if (n) { ring(n, 4.5, "rgba(63,185,80,0.35)", 5); }
    }
    for (const id of tf.pressureIds) {
      const n = layout.byId.get(id);
      if (n) { ring(n, 3, "#f85149", 3); ring(n, 7, "rgba(248,81,73,0.35)", 4); }
    }
  }

  // what-if selection
  if (state.selectedReceiverId) {
    const n = layout.byId.get(state.selectedReceiverId);
    if (n) {
      ring(n, 13, "#58a6ff", 2.5);
      ring(n, 16.5, "rgba(88,166,255,0.5)", 1.5);
    }
  }
}

/* ---- labels with collision avoidance ---- */

function lastName(name) {
  const parts = String(name || "").split(" ");
  return parts.length > 1 ? parts.slice(1).join(" ") : parts[0];
}

function collectLabels(frame, layout) {
  const a = state.playData.analysis;
  const afterThrow = a && a.hasPass && frame.frameId >= a.passForwardFrame;
  const showNames = state.zoom >= 2.2;
  const showAllNames = state.zoom >= 3.5;
  const bestId = frame.frameId >= bestVisibleFrom() ? bestOptionId() : null;
  const recById = new Map(frame.receivers.map((r) => [r.nflId, r]));
  const labels = [];

  for (const n of layout.nodes) {
    const p = n.p;
    const rec = recById.get(p.nflId);
    const tags = [];
    let priority = 0;
    let border = null;
    let bg = "rgba(13,17,23,0.85)";
    let fg = "#e6edf3";

    if (p.role === "Pass") { tags.push("QB"); priority = 3; }
    if (rec) {
      bg = opennessColor(rec.openness);
      fg = "#000";
      priority = Math.max(priority, 2);
    }
    if (afterThrow && a.target && a.target.nflId === p.nflId) {
      tags.push("TARGET"); priority = 4; border = "#d29922";
    }
    if (bestId === p.nflId) {
      tags.push("BEST"); priority = 4; border = border || "#3fb950";
    }
    if (p.nflId === state.selectedReceiverId) {
      tags.unshift("SELECTED"); priority = 5; border = "#58a6ff";
    }

    const parts = [...tags];
    if (showNames && (rec || p.role === "Pass")) parts.push(lastName(p.name));
    if (rec) parts.push(`${rec.openness.toFixed(1)}y`);

    if (parts.length) {
      labels.push({ node: n, text: parts.join(" · "), bg, fg, border, priority, optional: false });
    } else if (showAllNames) {
      // everyone else gets a name tag when zoomed far in, only if there's room
      labels.push({
        node: n, text: `${p.jersey} ${lastName(p.name)}`,
        bg: "rgba(13,17,23,0.7)", fg: "#c9d1d9", border: null, priority: 1, optional: true,
      });
    }
  }
  return labels;
}

function overlapArea(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

// candidate directions in order of preference: up, down, right, left, diagonals
const LABEL_ANGLES = [-90, 90, 0, 180, -45, -135, 45, 135].map((d) => d * Math.PI / 180);

function placeLabels(labels, layout) {
  const fontPx = Math.round(10 * Math.min(1.3, layout.k));
  ctx.font = `bold ${fontPx}px sans-serif`;
  const h = fontPx + 6;

  // markers are obstacles labels should avoid
  const obstacles = layout.nodes.map((n) => ({
    x: n.x - n.r - 2, y: n.y - n.r - 2, w: 2 * n.r + 4, h: 2 * n.r + 4,
  }));
  const placed = [];

  labels.sort((a, b) => b.priority - a.priority);
  for (const L of labels) {
    const w = ctx.measureText(L.text).width + 10;
    const n = L.node;
    let best = null;

    const distances = [n.r + 5, n.r + 18, n.r + 32];
    for (let di = 0; di < distances.length; di++) {
      const dist = distances[di];
      for (let ai = 0; ai < LABEL_ANGLES.length; ai++) {
        const ang = LABEL_ANGLES[ai];
        const cos = Math.cos(ang), sin = Math.sin(ang);
        const cx = n.x + cos * (dist + Math.abs(cos) * w / 2);
        const cy = n.y + sin * (dist + Math.abs(sin) * h / 2);
        const box = { x: cx - w / 2, y: cy - h / 2, w, h };

        let cost = 0;
        // keep labels inside the canvas
        if (box.x < 2 || box.y < 2 || box.x + w > CANVAS_W - 2 || box.y + h > CANVAS_H - 2) cost += 1e5;
        for (const o of obstacles) cost += overlapArea(box, o);
        for (const o of placed) cost += overlapArea(box, o) * 4;
        // prefer close and preferred directions
        cost += di * 40 + ai * 2;

        if (!best || cost < best.cost) best = { box, cost, far: di > 0, hasOverlap: cost >= 1e5 || cost - di * 40 - ai * 2 > 0 };
      }
      if (best && !best.hasOverlap) break; // found a clean spot at this distance
    }

    if (!best) continue;
    if (best.hasOverlap && L.optional) continue; // skip low-priority labels that would clutter
    L.box = best.box;
    L.leader = best.far;
    placed.push(best.box);
  }
  return { fontPx, h };
}

function drawLabels(frame, layout) {
  const labels = collectLabels(frame, layout);
  const { fontPx, h } = placeLabels(labels, layout);

  ctx.font = `bold ${fontPx}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (const L of labels) {
    if (!L.box) continue;
    const b = L.box;
    const n = L.node;

    // leader line when the label had to move away from its player
    if (L.leader) {
      const tx = Math.max(b.x, Math.min(n.x, b.x + b.w));
      const ty = Math.max(b.y, Math.min(n.y, b.y + b.h));
      const ang = Math.atan2(ty - n.y, tx - n.x);
      ctx.strokeStyle = L.border || "rgba(230,237,243,0.6)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(n.x + Math.cos(ang) * n.r, n.y + Math.sin(ang) * n.r);
      ctx.lineTo(tx, ty);
      ctx.stroke();
    }

    roundRect(ctx, b.x, b.y, b.w, b.h, 4);
    ctx.fillStyle = L.bg;
    ctx.fill();
    if (L.border) {
      ctx.strokeStyle = L.border;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.fillStyle = L.fg;
    ctx.fillText(L.text, b.x + b.w / 2, b.y + h / 2 + 0.5);
  }
}

/* ---- overlays (screen space) ---- */
function drawZoomIndicator() {
  if (state.zoom <= 1.001) return;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  roundRect(ctx, CANVAS_W - 70, CANVAS_H - 26, 60, 18, 4);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`${state.zoom.toFixed(1)}×`, CANVAS_W - 40, CANVAS_H - 17);
}

function drawEventBadge(frame) {
  if (!frame.event) return;
  const events = {
    ball_snap: { text: "SNAP", color: "#58a6ff" },
    pass_forward: { text: "PASS", color: "#d29922" },
    autoevent_passforward: { text: "PASS", color: "#d29922" },
    pass_arrived: { text: "ARRIVED", color: "#d29922" },
    pass_outcome_caught: { text: "CAUGHT", color: "#3fb950" },
    pass_outcome_incomplete: { text: "INCOMPLETE", color: "#f85149" },
    pass_outcome_interception: { text: "INTERCEPTED", color: "#f85149" },
    pass_outcome_touchdown: { text: "TOUCHDOWN", color: "#3fb950" },
    tackle: { text: "TACKLE", color: "#f85149" },
    out_of_bounds: { text: "OUT OF BOUNDS", color: "#f85149" },
    fumble: { text: "FUMBLE", color: "#f85149" },
    quarterback_sack: { text: "SACK", color: "#f85149" },
  };
  const e = events[frame.event] || { text: frame.event.toUpperCase(), color: "#8b949e" };
  ctx.font = "bold 14px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const w = ctx.measureText(e.text).width + 16;
  roundRect(ctx, CANVAS_W / 2 - w / 2, 8, w, 22, 5);
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fill();
  ctx.fillStyle = e.color;
  ctx.fillText(e.text, CANVAS_W / 2, 19);
}

/* ================================================================
   Animation
   ================================================================ */

function animate(ts) {
  if (!state.isPlaying) return;
  if (!state.lastTick) state.lastTick = ts;
  const elapsed = ts - state.lastTick;
  const frameDuration = 100 / state.playSpeed; // 10 Hz base

  if (elapsed >= frameDuration) {
    state.lastTick = ts;
    state.currentFrame++;
    if (state.currentFrame >= state.playData.frames.length) {
      state.currentFrame = 0; // loop
    }
    updateFrameLabel();
    updateOpennessList();
    highlightActiveMove();
    render();
  }
  state.rafId = requestAnimationFrame(animate);
}

function togglePlay() {
  if (!state.playData) return;
  state.isPlaying = !state.isPlaying;
  if (state.isPlaying) {
    $("btn-play").textContent = "⏸";
    state.lastTick = 0;
    state.rafId = requestAnimationFrame(animate);
  } else {
    $("btn-play").textContent = "▶";
    if (state.rafId) cancelAnimationFrame(state.rafId);
  }
}

function stepFrame(delta) {
  state.isPlaying = false;
  $("btn-play").textContent = "▶";
  if (state.rafId) cancelAnimationFrame(state.rafId);
  state.currentFrame = Math.max(0, Math.min(
    state.playData.frames.length - 1, state.currentFrame + delta));
  updateFrameLabel();
  updateOpennessList();
  highlightActiveMove();
  render();
}

/* ================================================================
   UI updates
   ================================================================ */

function updateUI() {
  if (!state.playData) return;
  const pi = state.playData.playInfo;

  // play info
  $("play-info-panel").style.display = "";
  const dn = pi.down ? `${pi.down}${["th","st","nd","rd"][Math.min(pi.down,3)]}` : "";
  const passResMap = { C: "Complete", I: "Incomplete", IN: "Intercepted", S: "Sack", R: "Scramble" };
  $("play-info").innerHTML = `
    <div class="description">${pi.description}</div>
    <div class="info-row"><span class="info-label">Down &amp; Distance</span><span class="info-value">${dn} &amp; ${pi.yardsToGo}</span></div>
    <div class="info-row"><span class="info-label">Possession</span><span class="info-value">${pi.possessionTeam}</span></div>
    <div class="info-row"><span class="info-label">Defense</span><span class="info-value">${pi.defensiveTeam}</span></div>
    <div class="info-row"><span class="info-label">Formation</span><span class="info-value">${pi.offenseFormation || "—"}</span></div>
    <div class="info-row"><span class="info-label">Coverage</span><span class="info-value">${pi.pff_passCoverage || "—"} (${pi.pff_passCoverageType || "—"})</span></div>
    <div class="info-row"><span class="info-label">Pass Result</span><span class="info-value">${passResMap[pi.passResult] || pi.passResult || "—"}</span></div>
    <div class="info-row"><span class="info-label">Play Result</span><span class="info-value">${pi.playResult} yds</span></div>
    <div class="info-row"><span class="info-label">Play Action</span><span class="info-value">${pi.pff_playAction ? "Yes" : "No"}</span></div>
  `;


  // scrubber
  $("scrubber").max = state.playData.frames.length - 1;
  $("scrubber").value = 0;
  updateFrameLabel();
  updateOpennessList();
}

function updateFrameLabel() {
  const total = state.playData ? state.playData.frames.length : 0;
  const f = state.currentFrame;
  const frame = state.playData ? state.playData.frames[f] : null;
  const time = frame ? (f * 0.1).toFixed(1) : "0.0";
  $("frame-label").textContent = `Frame ${f + 1} / ${total}  (${time}s)`;
  $("scrubber").value = f;
}

function updateOpennessList() {
  if (!state.playData) return;
  const frame = state.playData.frames[state.currentFrame];
  if (!frame) return;

  $("openness-panel").style.display = "";
  const analysis = state.playData.analysis;
  const targetId = analysis && analysis.target ? analysis.target.nflId : null;
  const bestId = frame.frameId >= bestVisibleFrom() ? bestOptionId() : null;

  let html = "";
  for (const rec of frame.receivers) {
    const isTarget = rec.nflId === targetId;
    const isBest = rec.nflId === bestId;
    const cls = isTarget && isBest ? "is-both" : isTarget ? "is-target" : isBest ? "is-mostopen" : "";
    const tag = isTarget ? " 🎯" : isBest ? " 🏆" : "";
    const pct = Math.min(rec.openness / 10 * 100, 100);
    const barColor = lerpColor("#f85149", "#3fb950", Math.min(rec.openness / 8, 1));
    html += `
      <div class="openness-row ${cls}">
        <span class="openness-name">${rec.name}${tag}</span>
        <div class="openness-bar-container">
          <div class="openness-bar" style="width:${pct}%;background:${barColor}"></div>
        </div>
        <span class="openness-val">${rec.openness.toFixed(1)}y</span>
      </div>`;
  }
  if (!html) html = "<div style='color:var(--text-dim);font-size:12px'>No receivers on this frame.</div>";
  $("openness-list").innerHTML = html;
}

/* ================================================================
   Pass options — multi-criteria evaluation (pass_options.py)
   ================================================================ */

const CRITERIA = [
  { key: "completion", label: "Completion", color: "#3fb950", hint: "probability the pass is caught" },
  { key: "conversion", label: "1st down", color: "#58a6ff", hint: "probability of a catch that moves the chains" },
  { key: "gain", label: "Yards", color: "#d29922", hint: "expected yards (15+ yds = 100)" },
  { key: "safety", label: "Safety", color: "#a371f7", hint: "low interception risk (8 %+ = 0)" },
];

function weightedScore(scores) {
  let s = 0, tot = 0;
  for (const c of CRITERIA) { s += scores[c.key] * state.weights[c.key]; tot += state.weights[c.key]; }
  return tot ? s / tot : 0;
}

function rankedOptions(data = state.simData) {
  if (!data) return [];
  return data.options
    .map((o) => ({ ...o, score: weightedScore(o.scores) }))
    .sort((a, b) => b.score - a.score);
}

function bestOptionId() {
  const r = rankedOptions();
  return r.length ? r[0].nflId : null;
}

// frame from which the BEST tag is drawn on the field
function bestVisibleFrom() {
  return state.simData ? state.simData.evalFrame : Infinity;
}

async function loadOptions(gameId, playId) {
  try {
    const d = await fetchJSON(`/api/options/${gameId}/${playId}`);
    if (!state.playData || state.playData.playInfo.playId !== playId) return;
    state.optionsBase = d;
    state.simData = d;
    if (!state.weightsTouched) state.weights = { ...d.defaultWeights };
  } catch (e) {
    console.error("options failed", e);
    state.optionsBase = state.simData = null;
  }
  renderWeights();
  renderSimList();
  renderPrecision(null);
  renderDecision();
  buildKeyMoments();
  render();
  if (state.optionsBase && state.optionsBase.passerId) {
    try {
      const qb = await fetchJSON(`/api/qb/${state.optionsBase.passerId}`);
      if (state.optionsBase && qb.passerId === state.optionsBase.passerId) renderPrecision(qb);
    } catch (e) { /* QB without enough passes: per-play precision only */ }
  }
}

async function evalAtCurrentFrame() {
  if (!state.playData || !state.optionsBase) return;
  const frame = state.playData.frames[state.currentFrame];
  if (frame.frameId < state.optionsBase.snapFrame) {
    $("po-frame-note").textContent = "Move after the snap to evaluate the options.";
    return;
  }
  const { gameId, playId } = state.playData.playInfo;
  $("po-frame-note").textContent = "Evaluating…";
  try {
    const d = await fetchJSON(`/api/options/${gameId}/${playId}?frame=${frame.frameId}`);
    d.timeline = state.optionsBase.timeline; // timeline does not depend on the frame
    state.simData = d;
  } catch (e) { console.error(e); }
  renderSimList();
  render();
}

function resetSim() {
  state.selectedReceiverId = null;
  state.simData = state.optionsBase;
  renderSimList();
  $("sim-detail").innerHTML = "";
  render();
}

function showBestOption() {
  const id = bestOptionId();
  if (id != null) selectReceiver(id);
}

/* ---- weights ---- */
function renderWeights() {
  $("po-weights").innerHTML = CRITERIA.map((c) => `
    <label class="po-w-row" title="${c.hint}">
      <span class="po-w-name" style="color:${c.color}">${c.label}</span>
      <input type="range" min="0" max="100" step="5" value="${state.weights[c.key]}"
             data-key="${c.key}" aria-label="${c.label} weight">
      <span class="po-w-val">${state.weights[c.key]}</span>
    </label>`).join("") +
    `<button id="po-w-reset" class="sim-btn secondary" type="button">Default weights</button>`;
  $("po-weights").querySelectorAll("input").forEach((inp) => {
    inp.addEventListener("input", () => {
      state.weights[inp.dataset.key] = parseInt(inp.value);
      state.weightsTouched = true;
      inp.nextElementSibling.textContent = inp.value;
      renderSimList();
      renderDecision();
      render();
    });
  });
  $("po-w-reset").addEventListener("click", () => {
    if (!state.optionsBase) return;
    state.weights = { ...state.optionsBase.defaultWeights };
    state.weightsTouched = false;
    renderWeights(); renderSimList(); renderDecision(); render();
  });
}

/* ---- option list ---- */
function miniBars(scores) {
  return `<div class="po-bars">${CRITERIA.map((c) => `
    <div class="po-bar" title="${c.label}: ${scores[c.key]} / 100">
      <div class="po-bar-fill" style="height:${scores[c.key]}%;background:${c.color}"></div>
    </div>`).join("")}</div>`;
}

function scoreColor(s) { return lerpColor("#f85149", "#3fb950", Math.min(Math.max((s - 30) / 50, 0), 1)); }

function renderSimList() {
  const d = state.simData;
  if (!d) { $("sim-panel").style.display = "none"; return; }
  $("sim-panel").style.display = "";

  const ranked = rankedOptions();
  const bestId = ranked.length ? ranked[0].nflId : null;
  const actualId = d.actualTargetId;
  const tEval = ((d.evalFrame - d.snapFrame) / 10).toFixed(1);
  $("po-frame-note").textContent = d.isThrowFrame
    ? `Options at the throw (${tEval}s after snap) vs ${d.coverage} coverage.`
    : `Options at ${tEval}s after snap (QB still holding the ball).`;

  renderOptionsVerdict(ranked);

  $("sim-list").innerHTML = ranked.map((o, i) => {
    const f = o.features;
    const cls = ["sim-row"];
    if (o.nflId === state.selectedReceiverId) cls.push("selected");
    if (o.nflId === actualId && d.isThrowFrame) cls.push("is-actual");
    if (o.nflId === bestId) cls.push("is-best");
    let tags = "";
    if (o.nflId === actualId) tags += `<span class="sim-tag actual">thrown</span>`;
    if (o.nflId === bestId) tags += `<span class="sim-tag best">best</span>`;
    return `
      <div class="sim-row ${cls.join(" ")}" data-id="${o.nflId}" tabindex="0" role="button"
           aria-label="${o.name}, pass score ${o.score.toFixed(0)}">
        <div class="po-row">
          <span class="po-rank">${i + 1}</span>
          <div class="po-main">
            <div class="sim-row-top">
              <span class="sim-row-name">${o.name}${tags}</span>
              <span class="po-score" style="color:${scoreColor(o.score)}">${o.score.toFixed(0)}</span>
            </div>
            <div class="sim-row-stats">
              <span>Comp <b>${o.completionProb}%</b></span>
              <span>1st <b>${o.firstDownProb}%</b></span>
              <span>xYds <b>${o.expectedYards}</b></span>
              <span>INT <b>${o.intProb}%</b></span>
            </div>
            <div class="po-inputs">sep at catch ${f.sep_arr}y · lane ${f.lane}y · depth ${f.depth}y</div>
          </div>
          ${miniBars(o.scores)}
        </div>
      </div>`;
  }).join("") || "<div class='hint-line'>No eligible receivers on this frame.</div>";

  $("sim-list").querySelectorAll(".sim-row").forEach((row) => {
    const pick = () => selectReceiver(parseInt(row.dataset.id));
    row.addEventListener("click", pick);
    row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
  });

  if (state.selectedReceiverId) renderSimDetail(state.selectedReceiverId);
  else $("sim-detail").innerHTML = "";
}

function criteriaDiff(a, b) {
  // criteria where a beats b by 10+ points
  return CRITERIA
    .map((c) => ({ c, d: a.scores[c.key] - b.scores[c.key] }))
    .filter((x) => x.d >= 10)
    .sort((x, y) => y.d - x.d)
    .map((x) => `${x.c.label.toLowerCase()} +${x.d.toFixed(0)}`);
}

function renderOptionsVerdict(ranked) {
  const d = state.simData;
  const el = $("po-verdict");
  if (!ranked.length) { el.innerHTML = ""; return; }
  const best = ranked[0];
  const actual = ranked.find((o) => o.nflId === d.actualTargetId);
  if (!d.isThrowFrame || !actual) {
    el.innerHTML = `<div class="tv-badge tv-cover">${d.isThrowFrame ? "Target unknown" : "Mid-play read"}</div>
      <div>Best option now: <b>${best.name}</b> (${best.score.toFixed(0)}).</div>`;
    return;
  }
  const gap = best.score - actual.score;
  let cls, title, text;
  if (actual.nflId === best.nflId) {
    cls = "tv-good"; title = "Best option chosen";
    text = `${actual.name} had the best overall score (${actual.score.toFixed(0)}).`;
  } else if (gap < 5) {
    cls = "tv-good"; title = "Close call";
    text = `${actual.name} (${actual.score.toFixed(0)}) was within ${gap.toFixed(0)} pts of ${best.name} (${best.score.toFixed(0)}).`;
  } else {
    const why = criteriaDiff(best, actual);
    cls = gap < 15 ? "tv-closing" : "tv-late";
    title = gap < 15 ? "Better option available" : "Clearly better option";
    text = `${best.name} scored ${best.score.toFixed(0)} vs ${actual.score.toFixed(0)} for ${actual.name}` +
      (why.length ? ` (${why.join(", ")}).` : ".");
  }
  el.innerHTML = `<div class="tv-badge ${cls}">${title}</div><div>${text}</div>`;
}

function selectReceiver(nflId) {
  state.selectedReceiverId = nflId;
  renderSimList();
  // jump to the frame being evaluated so the field matches the numbers
  if (state.simData) {
    const idx = state.playData.frames.findIndex((f) => f.frameId === state.simData.evalFrame);
    if (idx >= 0) {
      state.isPlaying = false;
      $("btn-play").textContent = "▶";
      if (state.rafId) cancelAnimationFrame(state.rafId);
      state.currentFrame = idx;
      updateFrameLabel();
      updateOpennessList();
      renderMoves();
    }
  }
  render();
}

function renderSimDetail(nflId) {
  const ranked = rankedOptions();
  const o = ranked.find((x) => x.nflId === nflId);
  if (!o) { $("sim-detail").innerHTML = ""; return; }
  const f = o.features;
  const actual = ranked.find((x) => x.nflId === state.simData.actualTargetId);

  let compare = "";
  if (actual && actual.nflId !== nflId && state.simData.isThrowFrame) {
    const gap = o.score - actual.score;
    const rows = CRITERIA.map((c) => {
      const dd = o.scores[c.key] - actual.scores[c.key];
      const col = dd > 0 ? "var(--green)" : dd < 0 ? "var(--red)" : "var(--text-dim)";
      return `<span style="color:${col}">${c.label} ${dd > 0 ? "+" : ""}${dd.toFixed(0)}</span>`;
    }).join(" · ");
    compare = `<div class="sim-meta">vs actual throw to ${actual.name}:
      <b style="color:${gap > 0 ? "var(--green)" : "var(--red)"}">${gap > 0 ? "+" : ""}${gap.toFixed(0)} pts</b><br>${rows}</div>`;
  }

  $("sim-detail").innerHTML = `
    <div class="sim-detail-card">
      <h3>Pass to ${o.name} · score ${o.score.toFixed(0)}</h3>
      <div class="sim-prob-bars">
        ${CRITERIA.map((c) => probBar(c.label, o.scores[c.key], 100, c.color, c.hint)).join("")}
      </div>
      <div class="sim-meta">
        <b>${o.completionProb}%</b> completion · <b>${o.firstDownProb}%</b> 1st down ·
        <b>${o.expectedYards}</b> expected yds (${o.yardsIfCaught} if caught) · <b>${o.intProb}%</b> INT.<br>
        Inputs: separation at the catch point <b>${f.sep_arr}y</b> (now ${f.sep_now}y),
        throwing lane <b>${f.lane}y</b>, depth <b>${f.depth}y</b>, nearest rusher to QB <b>${f.pressure}y</b>,
        ball in the air ~${f.t_air}s.<br>
        Based on ~${o.nEff} similar real passes (of ${state.simData.model.nPasses}).
      </div>
      ${compare}
    </div>`;
}

function probBar(label, val, max, color, hint) {
  const pct = Math.min(val / max * 100, 100);
  return `
    <div class="sim-prob" title="${hint || ""}">
      <span class="sim-prob-label">${label}</span>
      <div class="sim-prob-track">
        <div class="sim-prob-fill" style="width:${pct}%;background:${color}">${Math.round(val)}</div>
      </div>
    </div>`;
}

/* ---- precision ---- */
function renderPrecision(qb) {
  const d = state.optionsBase;
  if (!d) { $("precision-panel").style.display = "none"; return; }
  $("precision-panel").style.display = "";
  const p = d.precision;
  const res = { C: "Complete", I: "Incomplete", IN: "Intercepted" };
  let html = "";
  if (p) {
    const good = p.cpoe >= 0;
    html += `
      <div class="verdict-stats">
        <div class="stat"><div class="stat-label">Expected comp.</div><div class="stat-val">${p.expectedCompletion}%</div></div>
        <div class="stat"><div class="stat-label">Result</div><div class="stat-val ${p.result === "C" ? "good" : "bad"}">${res[p.result] || p.result}</div></div>
        <div class="stat"><div class="stat-label">CPOE (play)</div><div class="stat-val ${good ? "good" : "bad"}">${good ? "+" : ""}${p.cpoe}</div></div>
      </div>
      <div class="sim-meta">${p.result === "C"
        ? (p.expectedCompletion < 55 ? "Difficult completion: a precise throw." : "Completion on a throw the model expected.")
        : (p.expectedCompletion > 70 ? "Missed a throw that is usually completed." : "Incompletion on a difficult throw.")}</div>`;
  } else {
    html += `<div class="hint-line">No targeted pass on this play.</div>`;
  }
  if (qb) {
    const g = qb.cpoe >= 0;
    html += `
      <div class="po-qb">
        <div class="po-qb-title">${qb.name} · season (${qb.passes} passes)</div>
        <div class="verdict-stats">
          <div class="stat"><div class="stat-label">Comp %</div><div class="stat-val">${qb.completionPct}%</div></div>
          <div class="stat"><div class="stat-label">Expected</div><div class="stat-val">${qb.expectedCompletionPct}%</div></div>
          <div class="stat"><div class="stat-label">CPOE</div><div class="stat-val ${g ? "good" : "bad"}">${g ? "+" : ""}${qb.cpoe}</div></div>
          <div class="stat"><div class="stat-label">Rank</div><div class="stat-val">${qb.cpoeRank ? `${qb.cpoeRank}/${qb.qualifiedQbs}` : "—"}</div></div>
        </div>
      </div>`;
    state.qbProfile = qb;
  } else {
    state.qbProfile = null;
  }
  $("precision").innerHTML = html;
  renderDecision();
}

/* ---- decision timing ---- */
function decisionSeries() {
  const d = state.optionsBase;
  if (!d || !d.timeline || !d.timeline.length) return null;
  const pts = d.timeline.map((f) => {
    let best = null, actual = null;
    for (const o of f.options) {
      const s = weightedScore(o.scores);
      if (!best || s > best.s) best = { s, id: o.nflId };
      if (o.nflId === d.actualTargetId) actual = s;
    }
    return { t: f.t, frameId: f.frameId, best: best ? best.s : null, bestId: best ? best.id : null, actual };
  });
  // ignore the first 0.5 s (routes not developed yet) when looking for the peak
  const cand = pts.filter((p) => p.t >= 0.5 && p.best != null);
  const peak = (cand.length ? cand : pts).reduce((a, b) => (b.best > a.best ? b : a));
  return { pts, peak };
}

function playerName(id) {
  if (id == null || !state.playData) return "";
  const p = state.playData.frames[0].players.find((x) => x.nflId === id);
  return p ? p.name : `#${id}`;
}

function renderDecision() {
  const d = state.optionsBase;
  const ser = decisionSeries();
  if (!d || !ser) { $("decision-panel").style.display = "none"; return; }
  $("decision-panel").style.display = "";
  drawDecisionChart(ser);

  const ttt = d.timeToThrow;
  const thrown = ser.pts[ser.pts.length - 1];
  const lag = ttt != null ? ttt - ser.peak.t : null;
  const qb = state.qbProfile;
  const league = d.timeline.length && qb ? qb.leagueMedianTimeToThrow : null;
  const hold = state.timing ? state.timing.holdAfterOpen : null;

  let read;
  if (lag == null) read = "No throw on this play.";
  else if (lag <= 0.3) read = "The ball came out at (or right after) the best moment of the play.";
  else if (thrown.actual != null && thrown.actual >= ser.peak.best - 5) read = `Threw ${lag.toFixed(1)}s after the peak, but the chosen pass was still about as good.`;
  else read = `Best window was ${lag.toFixed(1)}s before the throw: the options got worse while the QB held the ball.`;

  $("decision").innerHTML = `
    <div class="verdict-stats">
      <div class="stat"><div class="stat-label">Time to throw</div><div class="stat-val">${ttt != null ? ttt.toFixed(1) + "s" : "—"}</div></div>
      <div class="stat"><div class="stat-label">Best window</div><div class="stat-val good">${ser.peak.t.toFixed(1)}s</div></div>
      <div class="stat"><div class="stat-label">Decision lag</div><div class="stat-val ${lag != null && lag > 0.5 ? "bad" : "good"}">${lag != null ? "+" + Math.max(lag, 0).toFixed(1) + "s" : "—"}</div></div>
      <div class="stat"><div class="stat-label">Hold after open</div><div class="stat-val">${hold != null ? hold.toFixed(1) + "s" : "—"}</div></div>
    </div>
    <div class="sim-meta">
      Peak: <b>${playerName(ser.peak.bestId)}</b> at ${ser.peak.best.toFixed(0)} pts.
      ${thrown.actual != null ? `Chosen pass at release: <b>${thrown.actual.toFixed(0)}</b> pts.` : ""}
      ${read}
      ${qb ? `<br>${qb.name}'s median time to throw: ${qb.medianTimeToThrow}s (league ${league}s).` : ""}
      <br><span class="hint-line">Click the chart to jump to that moment.</span>
    </div>`;
}

function drawDecisionChart(ser) {
  const c = $("decision-chart");
  const dpr = window.devicePixelRatio || 1;
  const W = c.clientWidth || 320, H = 110;
  c.width = W * dpr; c.height = H * dpr;
  const g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const padL = 26, padR = 8, padT = 8, padB = 18;
  const tMax = Math.max(ser.pts[ser.pts.length - 1].t, 0.1);
  const X = (t) => padL + (t / tMax) * (W - padL - padR);
  const Y = (s) => padT + (1 - s / 100) * (H - padT - padB);
  c._map = { X, tMax, padL, padR, W };

  g.strokeStyle = "#30363d"; g.lineWidth = 1;
  g.fillStyle = "#8b949e"; g.font = "9px sans-serif"; g.textAlign = "right"; g.textBaseline = "middle";
  for (const s of [0, 50, 100]) {
    g.beginPath(); g.moveTo(padL, Y(s)); g.lineTo(W - padR, Y(s)); g.stroke();
    g.fillText(String(s), padL - 4, Y(s));
  }
  g.textAlign = "center"; g.textBaseline = "top";
  for (let t = 0; t <= tMax + 1e-6; t += 1) g.fillText(`${t}s`, X(t), H - padB + 4);

  const line = (key, color, width) => {
    g.strokeStyle = color; g.lineWidth = width; g.beginPath();
    let on = false;
    for (const p of ser.pts) {
      if (p[key] == null) { on = false; continue; }
      if (!on) { g.moveTo(X(p.t), Y(p[key])); on = true; } else g.lineTo(X(p.t), Y(p[key]));
    }
    g.stroke();
  };
  line("best", "#3fb950", 2);
  line("actual", "#d29922", 1.5);

  // peak + throw markers
  g.fillStyle = "#3fb950";
  g.beginPath(); g.arc(X(ser.peak.t), Y(ser.peak.best), 3.5, 0, Math.PI * 2); g.fill();
  const thrown = ser.pts[ser.pts.length - 1];
  g.strokeStyle = "#e6edf3"; g.setLineDash([3, 3]);
  g.beginPath(); g.moveTo(X(thrown.t), padT); g.lineTo(X(thrown.t), H - padB); g.stroke();
  g.setLineDash([]);

  // current frame cursor
  const frame = state.playData && state.playData.frames[state.currentFrame];
  if (frame && state.optionsBase) {
    const t = (frame.frameId - state.optionsBase.snapFrame) / 10;
    if (t >= 0 && t <= tMax) {
      g.strokeStyle = "#58a6ff"; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(X(t), padT); g.lineTo(X(t), H - padB); g.stroke();
    }
  }

  // legend
  g.textAlign = "left"; g.textBaseline = "top"; g.font = "9px sans-serif";
  g.fillStyle = "#3fb950"; g.fillText("best option", padL + 4, padT);
  g.fillStyle = "#d29922"; g.fillText("chosen receiver", padL + 64, padT);
}

function handleDecisionClick(e) {
  const c = $("decision-chart");
  if (!c._map || !state.optionsBase || !state.playData) return;
  const rect = c.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const { tMax, padL, padR, W } = c._map;
  const t = Math.min(Math.max((x - padL) / (W - padL - padR), 0), 1) * tMax;
  const fid = state.optionsBase.snapFrame + Math.round(t * 10);
  const idx = state.playData.frames.findIndex((f) => f.frameId === fid);
  if (idx < 0) return;
  state.isPlaying = false;
  $("btn-play").textContent = "▶";
  if (state.rafId) cancelAnimationFrame(state.rafId);
  state.currentFrame = idx;
  updateFrameLabel(); updateOpennessList(); highlightActiveMove(); render();
}

/* ---- canvas coordinate helpers (account for zoom/pan) ---- */

// mouse event → logical canvas coords (0..CANVAS_W, 0..CANVAS_H)
function eventToCanvasPx(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (CANVAS_W / rect.width),
    y: (e.clientY - rect.top) * (CANVAS_H / rect.height),
  };
}

// size the canvas to its container (keeping the field aspect ratio) and match
// the backing store to the screen's pixel density so text stays crisp
function resizeCanvas() {
  const container = $("field-container");
  const availW = container.clientWidth;
  const availH = container.clientHeight;
  if (!availW || !availH) return;
  const ratio = CANVAS_W / CANVAS_H;
  let cssW = availW;
  let cssH = cssW / ratio;
  if (cssH > availH) { cssH = availH; cssW = cssH * ratio; }
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${Math.floor(cssW)}px`;
  canvas.style.height = `${Math.floor(cssH)}px`;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  state.viewScale = canvas.width / CANVAS_W;
  render();
}

/* ---- canvas click → select nearest receiver ---- */
function handleCanvasClick(e) {
  // ignore the click that ends a pan drag
  if (state.didPan) { state.didPan = false; return; }
  if (!state.playData || !state.simData || !state.lastLayout) return;
  const cpx = eventToCanvasPx(e);

  // hit-test against the markers as they are drawn right now (screen space),
  // so selection matches what you see at any zoom level
  const simIds = new Set(state.simData.options.map((r) => r.nflId));
  let best = null, bestD = Infinity;
  for (const n of state.lastLayout.nodes) {
    if (!simIds.has(n.p.nflId)) continue;
    const d = Math.hypot(n.x - cpx.x, n.y - cpx.y);
    if (d <= Math.max(n.r + 8, 14) && d < bestD) { bestD = d; best = n; }
  }
  if (best) selectReceiver(best.p.nflId);
}

/* ---- zoom & pan ---- */

function clampPan() {
  // prevent panning the field off the canvas edges
  const contentW = CANVAS_W * state.zoom;
  const contentH = CANVAS_H * state.zoom;
  const minX = CANVAS_W - contentW; // <= 0
  const minY = CANVAS_H - contentH;
  state.panX = Math.min(0, Math.max(minX, state.panX));
  state.panY = Math.min(0, Math.max(minY, state.panY));
  if (state.zoom <= 1) { state.panX = 0; state.panY = 0; }
}

// zoom toward a focal point given in canvas px
function zoomAt(focalX, focalY, newZoom) {
  newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, newZoom));
  if (newZoom === state.zoom) return;
  // keep the field point under the cursor fixed
  const fieldX = (focalX - state.panX) / state.zoom;
  const fieldY = (focalY - state.panY) / state.zoom;
  state.zoom = newZoom;
  state.panX = focalX - fieldX * state.zoom;
  state.panY = focalY - fieldY * state.zoom;
  clampPan();
  updateZoomButtons();
  render();
}

function handleWheel(e) {
  if (!state.playData) return;
  e.preventDefault();
  const cpx = eventToCanvasPx(e);
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  zoomAt(cpx.x, cpx.y, state.zoom * factor);
}

function handlePanStart(e) {
  if (state.zoom <= 1) return; // nothing to pan when not zoomed
  state.isPanning = true;
  state.didPan = false;
  const cpx = eventToCanvasPx(e);
  state.panStart = { mx: cpx.x, my: cpx.y, px: state.panX, py: state.panY };
  canvas.style.cursor = "grabbing";
}

function handlePanMove(e) {
  if (!state.isPanning) return;
  const cpx = eventToCanvasPx(e);
  const dx = cpx.x - state.panStart.mx;
  const dy = cpx.y - state.panStart.my;
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) state.didPan = true;
  state.panX = state.panStart.px + dx;
  state.panY = state.panStart.py + dy;
  clampPan();
  render();
}

function handlePanEnd() {
  if (!state.isPanning) return;
  state.isPanning = false;
  canvas.style.cursor = state.zoom > 1 ? "grab" : "pointer";
}

function zoomButton(delta) {
  // zoom centered on the canvas middle
  zoomAt(CANVAS_W / 2, CANVAS_H / 2, state.zoom + delta);
}

function resetZoom() {
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  updateZoomButtons();
  render();
}

function updateZoomButtons() {
  const zin = $("btn-zoom-in"), zout = $("btn-zoom-out"), zreset = $("btn-zoom-reset");
  if (zout) zout.disabled = state.zoom <= MIN_ZOOM + 0.001;
  if (zin) zin.disabled = state.zoom >= MAX_ZOOM - 0.001;
  if (zreset) zreset.style.display = state.zoom > 1.001 ? "" : "none";
  canvas.style.cursor = state.zoom > 1 ? "grab" : "pointer";
}

/* ================================================================
   Helpers
   ================================================================ */

function isLightColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (r * 0.299 + g * 0.587 + b * 0.114) > 150;
}

function lerpColor(c1, c2, t) {
  const r1 = parseInt(c1.slice(1, 3), 16), g1 = parseInt(c1.slice(3, 5), 16), b1 = parseInt(c1.slice(5, 7), 16);
  const r2 = parseInt(c2.slice(1, 3), 16), g2 = parseInt(c2.slice(3, 5), 16), b2 = parseInt(c2.slice(5, 7), 16);
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);
  return `rgb(${r},${g},${b})`;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function gameIdFromSelect() {
  return parseInt($("game-select").value);
}

/* ================================================================
   Init & events
   ================================================================ */

function initEvents() {
  // responsive, HiDPI canvas
  window.addEventListener("resize", resizeCanvas);
  if (window.ResizeObserver) new ResizeObserver(resizeCanvas).observe($("field-container"));

  $("game-select").addEventListener("change", (e) => {
    loadPlays(parseInt(e.target.value));
  });

  $("play-select").addEventListener("change", (e) => {
    loadPlay(gameIdFromSelect(), parseInt(e.target.value));
  });


  $("btn-play").addEventListener("click", togglePlay);
  $("btn-prev").addEventListener("click", () => stepFrame(-1));
  $("btn-next").addEventListener("click", () => stepFrame(1));

  $("scrubber").addEventListener("input", (e) => {
    state.isPlaying = false;
    $("btn-play").textContent = "▶";
    state.currentFrame = parseInt(e.target.value);
    updateFrameLabel();
    updateOpennessList();
    highlightActiveMove();
    render();
  });

  $("speed").addEventListener("change", (e) => {
    state.playSpeed = parseFloat(e.target.value);
  });

  // simulation controls
  $("btn-best").addEventListener("click", showBestOption);
  $("btn-eval-now").addEventListener("click", evalAtCurrentFrame);
  $("decision-chart").addEventListener("click", handleDecisionClick);
  $("btn-reset-sim").addEventListener("click", resetSim);
  canvas.addEventListener("click", handleCanvasClick);

  // zoom & pan
  canvas.addEventListener("wheel", handleWheel, { passive: false });
  canvas.addEventListener("mousedown", handlePanStart);
  canvas.addEventListener("mousemove", (e) => {
    if (state.isPanning || !state.lastLayout || !state.simData) return;
    const c = eventToCanvasPx(e);
    const simIds = new Set(state.simData.options.map((r) => r.nflId));
    const hover = state.lastLayout.nodes.some((n) =>
      simIds.has(n.p.nflId) && Math.hypot(n.x - c.x, n.y - c.y) <= Math.max(n.r + 8, 14));
    canvas.style.cursor = hover ? "pointer" : state.zoom > 1 ? "grab" : "default";
  });
  window.addEventListener("mousemove", handlePanMove);
  window.addEventListener("mouseup", handlePanEnd);
  $("btn-zoom-in").addEventListener("click", () => zoomButton(0.5));
  $("btn-zoom-out").addEventListener("click", () => zoomButton(-0.5));
  $("btn-zoom-reset").addEventListener("click", resetZoom);

  // chess-style move navigation
  $("btn-move-prev").addEventListener("click", () => jumpToMove(-1));
  $("btn-move-next").addEventListener("click", () => jumpToMove(1));

  // keyboard
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "SELECT") return;
    if (e.code === "Space") { e.preventDefault(); togglePlay(); }
    if (e.code === "ArrowLeft") { e.preventDefault(); stepFrame(-1); }
    if (e.code === "ArrowRight") { e.preventDefault(); stepFrame(1); }
    if (e.code === "ArrowUp") { e.preventDefault(); jumpToMove(-1); }
    if (e.code === "ArrowDown") { e.preventDefault(); jumpToMove(1); }
  });
}

async function init() {
  initEvents();
  updateZoomButtons();
  resizeCanvas(); // sizes the canvas and draws the empty field
  await loadGames();
}

init();
