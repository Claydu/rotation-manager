import { useState, useEffect, useRef } from "react";

// Players are internal ids only. Display names are entered in Setup and
// stored on the device (localStorage) — no real names live in this code
// or in the published app.
const PLAYERS = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"];
const defaultName = p => `Player ${PLAYERS.indexOf(p) + 1}`;

// ── U10 season format ────────────────────────────────────────────
// 5 on court from a squad of 7 (8 next season). Half length varies by
// competition, so the game format is preset in Setup: halves × half
// length, plus the sub interval. Every sub still swaps 2 girls: the
// on-court group is a window that slides 2 spots each rotation, so each
// girl plays stints of 2-3 rotations in a row rather than bitsy shifts.
const DEFAULT_SETTINGS = {
  squadSize: 7,   // girls in the squad (8 potentially next season)
  onCourt:   5,   // on the court at once
  halves:    2,
  halfMin:   18,  // minutes per half — adjust once the fixture is known
  subMin:    4,   // minutes between subs
};
function rotsFor(s) { return Math.max(1, Math.ceil((s.halves * s.halfMin) / s.subMin)); }

const KEY_TOURNEY = "u10_tourney_v1";
const KEY_NAMES   = "u8_names_v1";   // kept from last season so names carry over

// Storage: localStorage first (survives app/phone restarts), with an
// in-memory fallback so the app never crashes if storage is blocked.
const mem = {};
function persist(key, value) {
  const str = JSON.stringify(value);
  try { localStorage.setItem(key, str); } catch (e) {}
  mem[key] = str;
}
function retrieve(key) {
  try { const v = localStorage.getItem(key); if (v) return JSON.parse(v); } catch (e) {}
  try { if (mem[key]) return JSON.parse(mem[key]); } catch (e) {}
  return null;
}
function forget(key) {
  try { localStorage.removeItem(key); } catch (e) {}
  delete mem[key];
}

function applyAvailability(rotations, unavailable) {
  return rotations.map(rot => ({
    ...rot,
    onCourt: rot.onCourt.filter(p => !unavailable.includes(p)),
  }));
}

function buildSequence(rotations, allPlayers) {
  return rotations.map((rot, i) => {
    const prev  = rotations[i - 1];
    const on    = prev ? rot.onCourt.filter(p => !prev.onCourt.includes(p)) : [];
    const off   = prev ? prev.onCourt.filter(p => !rot.onCourt.includes(p)) : [];
    const bench = allPlayers.filter(p => !rot.onCourt.includes(p));
    return { ...rot, on, off, bench };
  });
}

// Build a game's rotations as a sliding window over a cycle of players:
// rotation i puts positions (2i … 2i+ON-1 mod n) on court, so every sub
// swaps at most 2 girls and each girl plays consecutive rotations in
// blocks. Positions don't get perfectly equal time within one game
// (5-of-7 never divides evenly), so the girls who are behind on day
// minutes are assigned to the highest-coverage positions, and the
// roster is offset per game so ties rotate who starts.
function generateRotations(cumTimes, players, gameIndex, onCourtN, nRots) {
  const n = players.length;
  if (n === 0) return Array.from({ length: nRots }, (_, i) => ({ id: i + 1, onCourt: [] }));
  const ON = Math.min(onCourtN, n);

  const coverage = Array(n).fill(0);
  const windows  = [];
  for (let i = 0; i < nRots; i++) {
    const w = Array.from({ length: ON }, (_, j) => (i * 2 + j) % n);
    windows.push(w);
    w.forEach(pos => { coverage[pos]++; });
  }

  const offset  = (gameIndex * 2) % n;
  const rotated = players.map((_, i) => players[(i + offset) % n]);
  const sorted  = [...rotated].sort((a, b) => (cumTimes[a] || 0) - (cumTimes[b] || 0));
  const posOrder = coverage.map((c, pos) => [c, pos])
    .sort((a, b) => b[0] - a[0] || a[1] - b[1]).map(([, pos]) => pos);
  const atPos = Array(n);
  posOrder.forEach((pos, j) => { atPos[pos] = sorted[j]; });

  return windows.map((w, i) => ({ id: i + 1, onCourt: w.map(pos => atPos[pos]) }));
}

function makeGame(index, rotations, unavailable) {
  return { id: `g${index + 1}-${Date.now()}`, label: `Game ${index + 1}`, rotations, log: [], notes: {}, unavailable };
}

// ── Game clock model ─────────────────────────────────────────────
// Each game is a log of timestamped events:
//   {type:'start', ts, rotIndex} {type:'sub', ts, rotIndex}
//   {type:'pause', ts} {type:'resume', ts} {type:'end', ts}
// All state (running/paused/ended, current rotation, court times) is
// derived from the log, so a reload or phone lock can never corrupt it.
function analyzeGame(log, sequence, players, now) {
  const times = {};
  players.forEach(p => { times[p] = 0; });
  const segments = []; // [{rotIndex, dur}] for the rotation log view
  let rotIndex = -1, running = false, last = null, status = "idle";
  let sinceSub = 0;
  let cur = null;

  for (const ev of log) {
    if (running && cur) {
      const dur = ev.ts - last;
      cur.dur += dur;
      sinceSub += dur;
      sequence[rotIndex]?.onCourt.forEach(p => { times[p] = (times[p] || 0) + dur; });
    }
    if (ev.type === "start" || ev.type === "sub") {
      rotIndex = ev.rotIndex;
      cur = { rotIndex, dur: 0 };
      segments.push(cur);
      running = true;
      sinceSub = 0;
      status = "running";
    } else if (ev.type === "pause") { running = false; status = "paused"; }
    else if (ev.type === "resume")  { running = true;  status = "running"; }
    else if (ev.type === "end")     { running = false; status = "ended"; }
    last = ev.ts;
  }
  if (running && cur) {
    const dur = now - last;
    cur.dur += dur;
    sinceSub += dur;
    sequence[rotIndex]?.onCourt.forEach(p => { times[p] = (times[p] || 0) + dur; });
  }
  return { times, segments, sinceSub, status, rotIndex: Math.max(rotIndex, 0) };
}

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function fmtNote(n) { return /^\d+$/.test(n) ? `#${n}` : n; }

const COLORS = ["#f97316","#22d3ee","#a78bfa","#34d399","#fb7185","#fbbf24","#60a5fa","#f472b6"];
function playerColor(p) { return COLORS[PLAYERS.indexOf(p) % COLORS.length]; }

const stepBtn = { background:"#ffffff15", border:"none", color:"#fff", borderRadius:8,
                  width:34, height:34, fontSize:18, fontWeight:800, cursor:"pointer" };
function NumSetting({ label, value, suffix = "", min, max, step = 1, onChange }) {
  return (
    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
                  padding:"8px 0", borderBottom:"1px solid #ffffff08" }}>
      <div style={{ fontSize:13, color:"#aaa" }}>{label}</div>
      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
        <button onClick={() => onChange(Math.max(min, value - step))} style={stepBtn}>−</button>
        <div style={{ fontSize:15, fontWeight:800, minWidth:58, textAlign:"center" }}>{value}{suffix}</div>
        <button onClick={() => onChange(Math.min(max, value + step))} style={stepBtn}>+</button>
      </div>
    </div>
  );
}

export default function App() {
  // Season + tournament state — a list of games; the last one is live.
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [games,    setGames]    = useState(() => [makeGame(0,
    generateRotations({}, PLAYERS.slice(0, DEFAULT_SETTINGS.squadSize), 0,
                      DEFAULT_SETTINGS.onCourt, rotsFor(DEFAULT_SETTINGS)), [])]);
  const [names,    setNames]    = useState({});
  const [absent,   setAbsent]   = useState([]);
  const [injured,  setInjured]  = useState([]);
  const [loaded,   setLoaded]   = useState(false);

  // UI
  const [view,      setView]      = useState("game");
  const [timeScope, setTimeScope] = useState("day");   // 'game' | 'day'
  const [swapModal, setSwapModal] = useState(null);
  const [noteModal, setNoteModal] = useState(null);    // player id being assigned a matchup
  const [noteDraft, setNoteDraft] = useState("");
  const [playerNotes, setPlayerNotes] = useState({});   // per-player game-day notes
  const [pNoteModal, setPNoteModal]   = useState(null); // player id whose note is being edited
  const [pNoteDraft, setPNoteDraft]   = useState("");
  const [shareStatus, setShareStatus] = useState(null); // null | 'shared' | 'copied' | 'error'
  const [confirmReset, setConfirmReset] = useState(null); // null | 'game' | 'day'
  const [now,       setNow]       = useState(Date.now());
  const [dragInfo,  setDragInfo]  = useState(null); // {rotIdx, player} while dragging
  const wakeLockRef = useRef(null);
  const dragRef     = useRef(null);

  // Derived
  const name          = p => (names[p] || "").trim() || defaultName(p);
  const ROSTER        = PLAYERS.slice(0, settings.squadSize);
  const ON            = settings.onCourt;
  const rotMs         = settings.subMin * 60 * 1000;
  const gameMs        = settings.halves * settings.halfMin * 60 * 1000;
  const unavailable   = [...absent, ...injured];
  const activePlayers = ROSTER.filter(p => !unavailable.includes(p));
  const curIdx        = games.length - 1;
  const curGame       = games[curIdx];
  const notes         = curGame.notes || {};

  // Analyze every game. Past games use the availability snapshot from
  // when they were played, so marking a girl away later never rewrites
  // the minutes she already earned.
  const analyses = games.map((g, i) => {
    const unav = i === curIdx ? unavailable : (g.unavailable || []);
    const act  = ROSTER.filter(p => !unav.includes(p));
    const seq  = buildSequence(applyAvailability(g.rotations, unav), act);
    return { ...analyzeGame(g.log, seq, PLAYERS, now), seq };
  });
  const game          = analyses[curIdx];
  const sequence      = game.seq;
  const effectiveRots = applyAvailability(curGame.rotations, unavailable);
  const { status }    = game;            // idle | running | paused | ended
  const currentRot    = game.rotIndex;
  const rot           = sequence[currentRot];
  const timerPct      = Math.min(game.sinceSub / rotMs, 1);
  const overdue       = status === "running" && game.sinceSub > rotMs;
  const gameStarted   = curGame.log.length > 0;
  const gameElapsed   = game.segments.reduce((s, seg) => s + seg.dur, 0);

  const dayTimes = {};
  PLAYERS.forEach(p => { dayTimes[p] = analyses.reduce((s, a) => s + (a.times[p] || 0), 0); });
  const daySegments = analyses.reduce((s, a) => s + a.segments.length, 0);

  // ── Load everything on mount ──────────────────────────────────
  useEffect(() => {
    const saved = retrieve(KEY_TOURNEY);
    if (saved?.games?.length) {
      setGames(saved.games);
      if (saved.absent)      setAbsent(saved.absent);
      if (saved.injured)     setInjured(saved.injured);
      if (saved.settings)    setSettings({ ...DEFAULT_SETTINGS, ...saved.settings });
      if (saved.playerNotes) setPlayerNotes(saved.playerNotes);
    }
    const savedNames = retrieve(KEY_NAMES);
    if (savedNames) setNames(savedNames);
    setLoaded(true);
  }, []);

  // ── Auto-save everything on every change ──────────────────────
  useEffect(() => {
    if (!loaded) return;
    persist(KEY_TOURNEY, { games, absent, injured, settings, playerNotes });
  }, [loaded, games, absent, injured, settings, playerNotes]);

  useEffect(() => {
    if (!loaded) return;
    persist(KEY_NAMES, names);
  }, [loaded, names]);

  // Keep the live game's availability snapshot in sync
  useEffect(() => {
    if (!loaded) return;
    const unav = [...absent, ...injured];
    setGames(prev => prev.map((g, i) => i === prev.length - 1 ? { ...g, unavailable: unav } : g));
  }, [loaded, absent, injured]);

  // ── Timer tick (only while clock is running) ──────────────────
  useEffect(() => {
    if (status !== "running") return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [status]);

  // ── Keep the screen awake during the game ─────────────────────
  useEffect(() => {
    if (status !== "running") {
      wakeLockRef.current?.release?.().catch(() => {});
      wakeLockRef.current = null;
      return;
    }
    let cancelled = false;
    async function acquire() {
      try {
        const lock = await navigator.wakeLock?.request("screen");
        if (cancelled) lock?.release?.();
        else wakeLockRef.current = lock;
      } catch (e) {}
    }
    acquire();
    const onVis = () => { if (document.visibilityState === "visible") acquire(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVis);
      wakeLockRef.current?.release?.().catch(() => {});
      wakeLockRef.current = null;
    };
  }, [status]);

  // ── Mutate the live game ──────────────────────────────────────
  function updateCurGame(fn) {
    setGames(prev => prev.map((g, i) => i === prev.length - 1 ? fn(g) : g));
  }
  function setCurRotations(updater) {
    updateCurGame(g => ({ ...g, rotations: typeof updater === "function" ? updater(g.rotations) : updater }));
  }
  function addEvent(ev) {
    updateCurGame(g => ({ ...g, log: [...g.log, { ...ev, ts: Date.now() }] }));
  }

  // ── Game controls ─────────────────────────────────────────────
  function startGame()  { updateCurGame(g => ({ ...g, log: [{ type: "start", ts: Date.now(), rotIndex: 0 }] })); }
  function pauseGame()  { addEvent({ type: "pause" }); }
  function resumeGame() { addEvent({ type: "resume" }); }
  function endGame()    { addEvent({ type: "end" }); }
  function undoEnd() {
    updateCurGame(g => g.log[g.log.length - 1]?.type === "end" ? { ...g, log: g.log.slice(0, -1) } : g);
  }
  function doSub() {
    if (currentRot >= sequence.length - 1) return;
    const evs = [];
    if (status === "paused") evs.push({ type: "resume", ts: Date.now() });
    evs.push({ type: "sub", ts: Date.now(), rotIndex: currentRot + 1 });
    updateCurGame(g => ({ ...g, log: [...g.log, ...evs] }));
  }
  function undoSub() {
    // Remove everything back to (and including) the most recent 'sub' event
    const idx = curGame.log.map(e => e.type).lastIndexOf("sub");
    if (idx <= 0) return;
    updateCurGame(g => ({ ...g, log: g.log.slice(0, idx) }));
  }

  // ── Season settings ───────────────────────────────────────────
  function updateSettings(patch) {
    const next = { ...settings, ...patch };
    setSettings(next);
    if (gameStarted) return;   // live game keeps its rotations
    const roster = PLAYERS.slice(0, next.squadSize);
    const act    = roster.filter(p => !unavailable.includes(p));
    setCurRotations(generateRotations(dayTimes, act, curIdx, next.onCourt, rotsFor(next)));
  }

  // ── Tournament controls ───────────────────────────────────────
  function startNextGame() {
    setGames(prev => [...prev, makeGame(prev.length,
      generateRotations(dayTimes, activePlayers, prev.length, ON, rotsFor(settings)), unavailable)]);
    setView("game");
  }
  function backToPrevGame() {
    // Only if the new game hasn't started — reopens the previous game
    if (curGame.log.length > 0 || games.length < 2) return;
    setGames(prev => prev.slice(0, -1));
  }
  function autoBalance() {
    if (gameStarted) return;
    setCurRotations(generateRotations(dayTimes, activePlayers, curIdx, ON, rotsFor(settings)));
  }
  function resetGame() {
    updateCurGame(g => ({ ...g, log: [] }));
    setConfirmReset(null);
  }
  function resetDay() {
    setGames([makeGame(0, generateRotations({}, activePlayers, 0, ON, rotsFor(settings)), unavailable)]);
    setPlayerNotes({});
    setConfirmReset(null);
  }

  // ── Guard matchups (opposition numbers) ───────────────────────
  function openNote(p) {
    setNoteModal(p);
    setNoteDraft(notes[p] || "");
  }
  function saveNote(value) {
    const v = value.trim().replace(/^#/, "");
    updateCurGame(g => {
      const nn = { ...(g.notes || {}) };
      if (v) nn[noteModal] = v; else delete nn[noteModal];
      return { ...g, notes: nn };
    });
    setNoteModal(null);
  }

  // ── Player game-day notes ─────────────────────────────────────
  function openPNote(p) {
    setPNoteModal(p);
    setPNoteDraft(playerNotes[p] || "");
  }
  function savePNote(value) {
    const v = value.trim();
    setPlayerNotes(prev => {
      const nn = { ...prev };
      if (v) nn[pNoteModal] = v; else delete nn[pNoteModal];
      return nn;
    });
    setPNoteModal(null);
  }

  // ── Export / share the day's stats ────────────────────────────
  // Plain text so it pastes cleanly into Apple Notes, Messages, etc.
  function buildExport() {
    const date = new Date().toLocaleDateString(undefined,
      { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    const lines = [`🏀 Game day — ${date}`];
    games.forEach((g, gi) => {
      const a = analyses[gi];
      if (a.segments.length === 0) return;
      const total = a.segments.reduce((s, seg) => s + seg.dur, 0);
      lines.push("", `${g.label} — ${fmt(total)} played, ${a.segments.length} rotation${a.segments.length !== 1 ? "s" : ""}`);
      ROSTER.forEach(p => { if (a.times[p] > 0) lines.push(`  ${name(p)}  ${fmt(a.times[p])}`); });
    });
    lines.push("", `Day totals (target ${fmt(gameTarget * games.length)} each)`);
    ROSTER.forEach(p => lines.push(`  ${name(p)}  ${fmt(dayTimes[p] || 0)}`));
    const noted = ROSTER.filter(p => (playerNotes[p] || "").trim());
    if (noted.length > 0) {
      lines.push("", "Player notes");
      noted.forEach(p => lines.push(`  ${name(p)}: ${playerNotes[p].trim()}`));
    }
    return lines.join("\n");
  }
  async function shareExport() {
    const text = buildExport();
    if (navigator.share) {
      try { await navigator.share({ title: "Game day summary", text }); setShareStatus("shared"); }
      catch (e) { return; }   // user closed the share sheet — no status
    } else {
      try { await navigator.clipboard.writeText(text); setShareStatus("copied"); }
      catch (e) { setShareStatus("error"); }
    }
    setTimeout(() => setShareStatus(null), 3000);
  }

  // ── Availability ──────────────────────────────────────────────
  function toggleAbsent(p) {
    setAbsent(prev  => prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p]);
    setInjured(prev => prev.filter(x => x !== p));
  }
  function toggleInjured(p) {
    setInjured(prev => prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p]);
    setAbsent(prev  => prev.filter(x => x !== p));
  }

  // ── Drag to reorder players within a rotation row ─────────────
  // Tap = open swap modal. Hold & move = drag; the other chips
  // shuffle live as the dragged player passes their position.
  function chipPointerDown(e, rotIdx, player) {
    dragRef.current = { rotIdx, player, startX: e.clientX, startY: e.clientY, dragging: false };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
  }
  function chipPointerMove(e, rotIdx, player) {
    const d = dragRef.current;
    if (!d || d.player !== player || d.rotIdx !== rotIdx) return;
    if (!d.dragging) {
      if (Math.abs(e.clientX - d.startX) < 10 && Math.abs(e.clientY - d.startY) < 10) return;
      d.dragging = true;
      setDragInfo({ rotIdx, player });
    }
    const row = e.currentTarget.closest("[data-row]");
    if (!row) return;
    const others = [...row.querySelectorAll("[data-chip]")].filter(c => c.dataset.chip !== player);
    // Target slot = how many other chips come before the pointer in reading order
    let idx = 0;
    for (const c of others) {
      const r = c.getBoundingClientRect();
      if (e.clientY > r.bottom || (e.clientY >= r.top && e.clientX > r.left + r.width / 2)) idx++;
    }
    setCurRotations(prev => prev.map((r, i) => {
      if (i !== rotIdx) return r;
      const cur = r.onCourt.indexOf(player);
      if (cur === -1 || cur === idx) return r;
      const arr = r.onCourt.filter(p => p !== player);
      arr.splice(idx, 0, player);
      return { ...r, onCourt: arr };
    }));
  }
  function chipPointerUp(e, rotIdx, player) {
    const d = dragRef.current;
    dragRef.current = null;
    setDragInfo(null);
    if (d && !d.dragging && !unavailable.includes(player)) {
      setSwapModal({ rotIdx, slotPlayer: player });
    }
  }
  function chipPointerCancel() {
    dragRef.current = null;
    setDragInfo(null);
  }

  // ── Swap modal ────────────────────────────────────────────────
  function doSwap(newPlayer) {
    if (!swapModal) return;
    const { rotIdx, slotPlayer } = swapModal;
    setCurRotations(prev => prev.map((r, i) => {
      if (i !== rotIdx) return r;
      if (slotPlayer === null) return { ...r, onCourt: [...r.onCourt, newPlayer] };
      return { ...r, onCourt: r.onCourt.map(p => p === slotPlayer ? newPlayer : p) };
    }));
    setSwapModal(null);
  }

  const canSub  = (status === "running" || status === "paused") && currentRot < sequence.length - 1;
  const canUndo = (status === "running" || status === "paused") && curGame.log.some(e => e.type === "sub");

  // Times tab scope
  const gameTarget  = activePlayers.length > 0
    ? gameMs * Math.min(ON, activePlayers.length) / activePlayers.length : 0;
  const scopeTimes  = timeScope === "game" ? game.times : dayTimes;
  const scopeTarget = timeScope === "game" ? gameTarget : gameTarget * games.length;
  const scopeSegs   = timeScope === "game" ? game.segments.length : daySegments;
  const scopeStarted = timeScope === "game" ? gameStarted : daySegments > 0;

  // ─────────────────────────────────────────────────────────────
  //  RENDER
  // ─────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight:"100vh", background:"#0a0a0f", color:"#f0f0f0",
                  fontFamily:"'DM Sans','Segoe UI',sans-serif", paddingBottom:90 }}>

      {/* Header */}
      <div style={{ background:"linear-gradient(135deg,#1a1a2e,#16213e)",
                    borderBottom:"1px solid #ffffff15", padding:"16px 20px 12px",
                    position:"sticky", top:0, zIndex:10 }}>
        <div style={{ fontSize:11, letterSpacing:3, color:"#f97316", fontWeight:700, textTransform:"uppercase" }}>
          U10 Basketball
        </div>
        <div style={{ fontSize:22, fontWeight:800, marginTop:2, display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
          Rotation Manager
          <span style={{ fontSize:11, color:"#f97316", background:"#f9731620",
                         borderRadius:6, padding:"2px 8px", fontWeight:700 }}>{curGame.label}</span>
          {status === "running" && (
            <span style={{ fontSize:11, color:"#22d3ee", background:"#22d3ee20",
                           borderRadius:6, padding:"2px 8px", fontWeight:600 }}>● LIVE</span>
          )}
          {status === "paused" && (
            <span style={{ fontSize:11, color:"#fbbf24", background:"#fbbf2420",
                           borderRadius:6, padding:"2px 8px", fontWeight:600 }}>⏸ PAUSED</span>
          )}
          {status === "ended" && (
            <span style={{ fontSize:11, color:"#888", background:"#ffffff15",
                           borderRadius:6, padding:"2px 8px", fontWeight:600 }}>FINAL</span>
          )}
        </div>
      </div>

      {/* Nav */}
      <div style={{ display:"flex", background:"#111", borderBottom:"1px solid #ffffff10" }}>
        {[["game","▶ Game"],["setup","⚙ Setup"],["times","⏱ Time"]].map(([v, label]) => (
          <button key={v} onClick={() => setView(v)} style={{
            flex:1, padding:"10px 0",
            background: view===v ? "#f97316" : "transparent",
            color: view===v ? "#000" : "#888",
            border:"none", fontWeight:700, fontSize:13, cursor:"pointer" }}>{label}</button>
        ))}
      </div>

      {/* ══ GAME VIEW ══ */}
      {view === "game" && (
        <div style={{ padding:16 }}>

          {/* Timer ring */}
          {(status === "running" || status === "paused") && (
            <div style={{ textAlign:"center", margin:"16px 0" }}>
              <div style={{ position:"relative", display:"inline-block" }}>
                <svg width={130} height={130} style={{ transform:"rotate(-90deg)" }}>
                  <circle cx={65} cy={65} r={55} fill="none" stroke="#ffffff10" strokeWidth={10}/>
                  <circle cx={65} cy={65} r={55} fill="none"
                    stroke={status==="paused" ? "#fbbf24" : overdue ? "#ef4444" : "#f97316"} strokeWidth={10}
                    strokeDasharray={`${2*Math.PI*55}`}
                    strokeDashoffset={`${2*Math.PI*55*(1-timerPct)}`}
                    strokeLinecap="round"
                    style={{ transition:"stroke-dashoffset 1s linear, stroke 0.3s" }}/>
                </svg>
                <div style={{ position:"absolute", top:"50%", left:"50%",
                              transform:"translate(-50%,-50%)", textAlign:"center" }}>
                  <div style={{ fontSize:28, fontWeight:800,
                                color: status==="paused" ? "#fbbf24" : overdue ? "#ef4444" : "#fff" }}>
                    {fmt(game.sinceSub)}
                  </div>
                  <div style={{ fontSize:10, color:"#888", letterSpacing:1 }}>
                    {status === "paused" ? "PAUSED" : "SINCE SUB"}
                  </div>
                </div>
              </div>
              <div style={{ marginTop:4, fontSize:13, fontWeight:600,
                            color: gameElapsed > gameMs ? "#ef4444" : "#888" }}>
                Game clock {fmt(gameElapsed)} / {fmt(gameMs)}
                {settings.halves === 2 && ` · ${gameElapsed < settings.halfMin*60*1000 ? "1st" : "2nd"} half`}
                {gameElapsed > gameMs && " — over time!"}
              </div>
              {overdue && (
                <div style={{ background:"#ef444420", border:"1px solid #ef4444",
                              borderRadius:8, padding:"6px 16px", marginTop:8,
                              display:"inline-block", color:"#ef4444", fontWeight:700, fontSize:13 }}>
                  ⚠ Sub overdue!
                </div>
              )}
            </div>
          )}

          {/* Rotation card */}
          {rot && status !== "ended" && (
            <div style={{ background:"linear-gradient(135deg,#1e1e3f,#1a1a2e)",
                          borderRadius:16, padding:20, border:"1px solid #ffffff15", marginBottom:16 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
                <div>
                  <div style={{ fontSize:10, color:"#888", letterSpacing:2, textTransform:"uppercase" }}>
                    {curGame.label} · Rotation
                  </div>
                  <div style={{ fontSize:36, fontWeight:900, lineHeight:1 }}>
                    {currentRot+1}<span style={{ fontSize:16, color:"#888" }}>/{sequence.length}</span>
                  </div>
                </div>
                {status === "idle" && (
                  <button onClick={startGame} style={{
                    background:"#f97316", color:"#000", border:"none",
                    borderRadius:50, width:64, height:64, fontSize:28, fontWeight:900, cursor:"pointer" }}>▶</button>
                )}
                {status === "running" && (
                  <button onClick={pauseGame} style={{
                    background:"#fbbf24", color:"#000", border:"none",
                    borderRadius:50, width:64, height:64, fontSize:24, fontWeight:900, cursor:"pointer" }}>⏸</button>
                )}
                {status === "paused" && (
                  <button onClick={resumeGame} style={{
                    background:"#22d3ee", color:"#000", border:"none",
                    borderRadius:50, width:64, height:64, fontSize:28, fontWeight:900, cursor:"pointer" }}>▶</button>
                )}
              </div>

              {status === "paused" && (
                <div style={{ background:"#fbbf2415", border:"1px solid #fbbf2450", borderRadius:10,
                              padding:"8px 14px", marginBottom:12, fontSize:13, color:"#fbbf24", fontWeight:600 }}>
                  ⏸ Clock stopped — court time isn't counting. Tap ▶ to resume.
                </div>
              )}

              {rot.on.length > 0 && (
                <div style={{ marginBottom:12 }}>
                  <div style={{ fontSize:10, letterSpacing:2, color:"#22d3ee", marginBottom:6, textTransform:"uppercase" }}>🟢 Sub ON</div>
                  <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
                    {rot.on.map(p => (
                      <span key={p} style={{ background:playerColor(p)+"30", border:`1.5px solid ${playerColor(p)}`,
                                             borderRadius:20, padding:"4px 12px", fontSize:14, fontWeight:700, color:playerColor(p) }}>{name(p)}</span>
                    ))}
                  </div>
                </div>
              )}
              {rot.off.length > 0 && (
                <div style={{ marginBottom:12 }}>
                  <div style={{ fontSize:10, letterSpacing:2, color:"#fb7185", marginBottom:6, textTransform:"uppercase" }}>🔴 Sub OFF</div>
                  <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
                    {rot.off.map(p => (
                      <span key={p} style={{ background:playerColor(p)+"20", border:`1.5px solid ${playerColor(p)}60`,
                                             borderRadius:20, padding:"4px 12px", fontSize:14, fontWeight:600, color:playerColor(p)+"cc" }}>
                        {name(p)}{notes[p] ? ` · frees ${fmtNote(notes[p])}` : ""}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ height:1, background:"#ffffff10", margin:"12px 0" }}/>

              <div>
                <div style={{ fontSize:10, letterSpacing:2, color:"#aaa", marginBottom:8, textTransform:"uppercase" }}>
                  On Court Now — tap a player to set who she's guarding
                  {rot.onCourt.length < ON && (
                    <span style={{ marginLeft:8, color:"#ef4444" }}>({rot.onCourt.length}/{ON}) — tap + to fill</span>
                  )}
                </div>
                <div style={{ display:"flex", flexWrap:"wrap", gap:8 }}>
                  {rot.onCourt.map(p => (
                    <button key={p} onClick={() => openNote(p)} style={{
                      background:playerColor(p), color:"#000", border:"none",
                      borderRadius:12, padding:"7px 12px", cursor:"pointer", textAlign:"left" }}>
                      <div style={{ fontSize:14, fontWeight:800 }}>{name(p)}</div>
                      <div style={{ fontSize:11, fontWeight:700, opacity: notes[p] ? 0.9 : 0.45 }}>
                        {notes[p] ? `🛡 ${fmtNote(notes[p])}` : "＋ matchup"}
                      </div>
                    </button>
                  ))}
                  {Array.from({ length: Math.max(0, ON - rot.onCourt.length) }).map((_, i) => (
                    <button key={"empty-"+i}
                      onClick={() => setSwapModal({ rotIdx:currentRot, slotPlayer:null })}
                      style={{ background:"#ef444415", border:"1.5px dashed #ef4444",
                               borderRadius:12, padding:"7px 14px", fontSize:14,
                               fontWeight:700, color:"#ef4444", cursor:"pointer" }}>+ Fill spot</button>
                  ))}
                </div>
              </div>

              <div style={{ marginTop:12 }}>
                <div style={{ fontSize:10, letterSpacing:2, color:"#555", marginBottom:6, textTransform:"uppercase" }}>Bench</div>
                <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
                  {rot.bench.map(p => (
                    <span key={p} style={{ background:"#ffffff10", borderRadius:20,
                                           padding:"4px 12px", fontSize:13, color:"#666" }}>{name(p)}</span>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Next sub preview */}
          {currentRot < sequence.length - 1 && status !== "ended" && (
            <div style={{ background:"#ffffff08", borderRadius:12, padding:14,
                          border:"1px solid #ffffff0a", marginBottom:16 }}>
              <div style={{ fontSize:10, letterSpacing:2, color:"#666", marginBottom:8, textTransform:"uppercase" }}>Next Sub</div>
              <div style={{ display:"flex", gap:20 }}>
                <div>
                  <div style={{ fontSize:10, color:"#22d3ee80", marginBottom:4 }}>IN</div>
                  {sequence[currentRot+1].on.map(p => (
                    <div key={p} style={{ fontSize:13, color:"#22d3ee", fontWeight:700 }}>{name(p)}</div>
                  ))}
                </div>
                <div>
                  <div style={{ fontSize:10, color:"#fb718580", marginBottom:4 }}>OUT</div>
                  {sequence[currentRot+1].off.map(p => (
                    <div key={p} style={{ fontSize:13, color:"#fb7185", fontWeight:700 }}>
                      {name(p)}{notes[p] ? <span style={{ color:"#fb718590", fontWeight:600 }}> · frees {fmtNote(notes[p])}</span> : ""}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Sub controls */}
          {status !== "ended" && (
            <div style={{ display:"flex", gap:10 }}>
              <button onClick={undoSub} disabled={!canUndo} style={{
                flex:1, padding:"14px 0",
                background: !canUndo ? "#ffffff08" : "#ffffff15",
                color: !canUndo ? "#444" : "#fff",
                border:"1px solid #ffffff15", borderRadius:12, fontSize:15, fontWeight:700,
                cursor: !canUndo ? "default" : "pointer" }}>← Undo</button>
              <button onClick={doSub} disabled={!canSub} style={{
                flex:2, padding:"14px 0",
                background: !canSub ? "#ffffff08" : "linear-gradient(135deg,#f97316,#fb923c)",
                color: !canSub ? "#444" : "#000",
                border:"none", borderRadius:12, fontSize:17, fontWeight:900,
                cursor: !canSub ? "default" : "pointer" }}>Make Sub →</button>
            </div>
          )}

          {/* End game */}
          {(status === "running" || status === "paused") && (
            <button onClick={endGame} style={{
              width:"100%", marginTop:10, padding:"12px 0",
              background:"#ef444420", color:"#ef4444",
              border:"1px solid #ef444460", borderRadius:12, fontSize:14, fontWeight:700, cursor:"pointer" }}>
              ■ End {curGame.label} (final whistle)
            </button>
          )}

          {/* Between games */}
          {status === "ended" && (
            <div style={{ padding:16, background:"#22d3ee10",
                          border:"1px solid #22d3ee40", borderRadius:12, textAlign:"center" }}>
              <div style={{ fontSize:15, fontWeight:800, color:"#22d3ee" }}>🏀 {curGame.label} done!</div>
              <div style={{ fontSize:12, color:"#888", marginTop:4 }}>
                Court times are banked for the day — check the ⏱ Time tab.
              </div>
              <button onClick={startNextGame} style={{
                width:"100%", marginTop:14, padding:"14px 0",
                background:"linear-gradient(135deg,#f97316,#fb923c)", color:"#000",
                border:"none", borderRadius:12, fontSize:17, fontWeight:900, cursor:"pointer" }}>
                ▶ Set up Game {games.length + 1}
              </button>
              <div style={{ fontSize:11, color:"#666", marginTop:8 }}>
                Lineup is auto-balanced from everyone's minutes so far — tweak it in ⚙ Setup before tip-off.
              </div>
              <button onClick={shareExport} style={{
                width:"100%", marginTop:10, padding:"11px 0",
                background:"#ffffff12", color:"#ddd",
                border:"1px solid #ffffff20", borderRadius:10, fontSize:14, fontWeight:700, cursor:"pointer" }}>
                {shareStatus === "shared" ? "✓ Shared!" : shareStatus === "copied" ? "✓ Copied to clipboard" : "📤 Share day summary"}
              </button>
              <button onClick={undoEnd} style={{
                marginTop:10, padding:"8px 16px", background:"transparent", color:"#555",
                border:"1px solid #333", borderRadius:8, fontSize:12, cursor:"pointer" }}>
                ↺ Undo end (resume this game)
              </button>
            </div>
          )}

          {/* Oops — created next game too early */}
          {status === "idle" && curIdx > 0 && !gameStarted && (
            <button onClick={backToPrevGame} style={{
              width:"100%", marginTop:10, padding:"10px 0",
              background:"transparent", color:"#555",
              border:"1px solid #333", borderRadius:10, fontSize:13, cursor:"pointer" }}>
              ← Back to {games[curIdx-1].label}
            </button>
          )}

          {gameStarted && status !== "ended" && (
            confirmReset === "game" ? (
              <div style={{ display:"flex", gap:10, marginTop:10 }}>
                <button onClick={() => setConfirmReset(null)} style={{
                  flex:1, padding:"10px 0", background:"#ffffff10", color:"#aaa",
                  border:"1px solid #333", borderRadius:10, fontSize:13, cursor:"pointer" }}>Cancel</button>
                <button onClick={resetGame} style={{
                  flex:1, padding:"10px 0", background:"#ef4444", color:"#fff",
                  border:"none", borderRadius:10, fontSize:13, fontWeight:700, cursor:"pointer" }}>
                  Yes, wipe {curGame.label}
                </button>
              </div>
            ) : (
              <button onClick={() => setConfirmReset("game")} style={{
                width:"100%", marginTop:10, padding:"10px 0",
                background:"transparent", color:"#555",
                border:"1px solid #333", borderRadius:10, fontSize:13, cursor:"pointer" }}>
                ↺ Reset {curGame.label} (clock &amp; times, this game only)
              </button>
            )
          )}

          {(absent.length > 0 || injured.length > 0) && (
            <div style={{ marginTop:16, padding:12, background:"#ffffff06",
                          borderRadius:10, border:"1px solid #ffffff0a" }}>
              {absent.length > 0  && <div style={{ color:"#888",   fontSize:12 }}>Absent: {absent.map(name).join(", ")}</div>}
              {injured.length > 0 && <div style={{ color:"#fbbf24",fontSize:12, marginTop:4 }}>⚠ Injured: {injured.map(name).join(", ")}</div>}
            </div>
          )}
        </div>
      )}

      {/* ══ SETUP VIEW ══ */}
      {view === "setup" && (
        <div style={{ padding:16 }}>
          <div style={{ fontSize:15, fontWeight:700, marginBottom:4 }}>Game Format</div>
          <div style={{ fontSize:12, color:"#666", marginBottom:8 }}>
            Preset the game length once you know this season's halves. Changes apply to games that haven't started.
          </div>
          <div style={{ background:"#ffffff08", borderRadius:12, padding:"4px 14px", border:"1px solid #ffffff0a", marginBottom:8 }}>
            <NumSetting label="Halves"            value={settings.halves}    min={1} max={4}
                        onChange={v => updateSettings({ halves: v })}/>
            <NumSetting label="Half length"       value={settings.halfMin}   min={4} max={30} suffix=" min"
                        onChange={v => updateSettings({ halfMin: v })}/>
            <NumSetting label="Sub every"         value={settings.subMin}    min={1} max={10} suffix=" min"
                        onChange={v => updateSettings({ subMin: v })}/>
            <NumSetting label="On court at once"  value={settings.onCourt}   min={3} max={5}
                        onChange={v => updateSettings({ onCourt: v })}/>
            <NumSetting label="Girls in squad"    value={settings.squadSize} min={5} max={8}
                        onChange={v => updateSettings({ squadSize: v })}/>
          </div>
          <div style={{ fontSize:12, color:"#888", marginBottom:24 }}>
            Game = {settings.halves} × {settings.halfMin}:00 = {fmt(gameMs)} · {rotsFor(settings)} rotations
            · everyone ≈ {fmt(gameTarget)} per game
          </div>

          <div style={{ fontSize:15, fontWeight:700, marginBottom:4 }}>Player Names</div>
          <div style={{ fontSize:12, color:"#666", marginBottom:12 }}>
            Names are saved on this phone only — never published anywhere
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:24 }}>
            {ROSTER.map(p => (
              <input key={p}
                value={names[p] ?? ""}
                placeholder={defaultName(p)}
                onChange={e => setNames(prev => ({ ...prev, [p]: e.target.value }))}
                style={{ background:"#ffffff08", border:`1.5px solid ${playerColor(p)}70`,
                         borderRadius:10, padding:"10px 12px", fontSize:16, fontWeight:700,
                         color:playerColor(p), outline:"none", width:"100%" }} />
            ))}
          </div>

          <div style={{ fontSize:15, fontWeight:700, marginBottom:4 }}>Player Availability</div>
          <div style={{ fontSize:12, color:"#666", marginBottom:12 }}>
            Mark absent or injured — removed from all rotations automatically
          </div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:8, marginBottom:24 }}>
            {ROSTER.map(p => {
              const isAbsent  = absent.includes(p);
              const isInjured = injured.includes(p);
              return (
                <div key={p} style={{
                  background: isAbsent?"#ef444420":isInjured?"#fbbf2420":playerColor(p)+"20",
                  border:`1.5px solid ${isAbsent?"#ef4444":isInjured?"#fbbf24":playerColor(p)}`,
                  borderRadius:12, padding:"8px 12px" }}>
                  <div style={{ fontWeight:700, fontSize:14,
                                color:isAbsent?"#ef4444":isInjured?"#fbbf24":playerColor(p) }}>{name(p)}</div>
                  <div style={{ display:"flex", gap:4, marginTop:4 }}>
                    <button onClick={() => toggleAbsent(p)} style={{
                      fontSize:10, padding:"2px 6px",
                      background:isAbsent?"#ef4444":"#ffffff15",
                      color:isAbsent?"#fff":"#888",
                      border:"none", borderRadius:4, cursor:"pointer" }}>Away</button>
                    <button onClick={() => toggleInjured(p)} style={{
                      fontSize:10, padding:"2px 6px",
                      background:isInjured?"#fbbf24":"#ffffff15",
                      color:isInjured?"#000":"#888",
                      border:"none", borderRadius:4, cursor:"pointer" }}>⚠ Inj</button>
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4 }}>
            <div style={{ fontSize:15, fontWeight:700 }}>{curGame.label} Rotations</div>
            <button onClick={autoBalance} disabled={gameStarted} style={{
              fontSize:13, padding:"6px 16px", fontWeight:700, border:"none",
              background: gameStarted ? "#ffffff08" : "#f97316",
              color: gameStarted ? "#444" : "#000",
              borderRadius:8, cursor: gameStarted ? "default" : "pointer" }}>
              ✨ Auto-balance
            </button>
          </div>
          <div style={{ fontSize:12, color:"#666", marginBottom:12 }}>
            Every sub swaps 2 girls, so each girl plays a few rotations in a row.
            {gameStarted
              ? " Game underway — tap a player to swap, hold & drag to reorder."
              : " Auto-balance rebuilds the lineup from everyone's minutes so far today."}
            {" "}Everything saves automatically.
          </div>

          {curGame.rotations.map((rotRow, i) => {
            const effRot = effectiveRots[i];
            const seq    = sequence[i];
            return (
              <div key={rotRow.id} style={{ background:"#ffffff08", borderRadius:12, padding:14,
                                         marginBottom:10, border:"1px solid #ffffff0a" }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <div style={{ fontSize:12, color:"#888" }}>
                    Rotation {i+1} <span style={{ color:"#555" }}>({fmt(i*rotMs)}–{fmt(Math.min((i+1)*rotMs, gameMs))})</span>
                    {effRot.onCourt.length < ON && (
                      <span style={{ marginLeft:8, color:"#ef4444", fontSize:11 }}>
                        ⚠ {effRot.onCourt.length}/{ON} players
                      </span>
                    )}
                  </div>
                  <div style={{ display:"flex", gap:4 }}>
                    {i > 0 && (
                      <button onClick={() => setCurRotations(prev => { const r=[...prev]; [r[i-1],r[i]]=[r[i],r[i-1]]; return r; })}
                        style={{ background:"#ffffff15", border:"none", color:"#fff",
                                 borderRadius:6, padding:"3px 8px", cursor:"pointer" }}>↑</button>
                    )}
                    {i < curGame.rotations.length-1 && (
                      <button onClick={() => setCurRotations(prev => { const r=[...prev]; [r[i],r[i+1]]=[r[i+1],r[i]]; return r; })}
                        style={{ background:"#ffffff15", border:"none", color:"#fff",
                                 borderRadius:6, padding:"3px 8px", cursor:"pointer" }}>↓</button>
                    )}
                  </div>
                </div>
                <div data-row style={{ display:"flex", flexWrap:"wrap", gap:6, marginTop:10 }}>
                  {rotRow.onCourt.map(p => {
                    const isUnavail = unavailable.includes(p);
                    const isDragging = dragInfo?.rotIdx === i && dragInfo?.player === p;
                    return (
                      <button key={p} data-chip={p}
                        onPointerDown={e => chipPointerDown(e, i, p)}
                        onPointerMove={e => chipPointerMove(e, i, p)}
                        onPointerUp={e => chipPointerUp(e, i, p)}
                        onPointerCancel={chipPointerCancel}
                        onContextMenu={e => e.preventDefault()}
                        style={{ background:isUnavail?"#ef444430":playerColor(p),
                                 color:isUnavail?"#ef4444":"#000",
                                 border:isUnavail?"1.5px dashed #ef4444":"none",
                                 borderRadius:20, padding:"5px 12px", fontSize:13, fontWeight:700,
                                 cursor:isUnavail?"default":"grab",
                                 display:"flex", alignItems:"center", gap:4,
                                 touchAction:"pan-y", userSelect:"none", WebkitUserSelect:"none",
                                 WebkitTouchCallout:"none",
                                 transform:isDragging?"scale(1.12)":"none",
                                 boxShadow:isDragging?`0 4px 16px ${playerColor(p)}80`:"none",
                                 position:isDragging?"relative":"static", zIndex:isDragging?5:"auto",
                                 transition:"transform 0.15s, box-shadow 0.15s" }}>
                        {isUnavail && <span style={{ fontSize:10 }}>✕</span>}
                        {name(p)}
                        {!isUnavail && <span style={{ fontSize:10, opacity:0.6 }}>⇄</span>}
                      </button>
                    );
                  })}
                  {Array.from({ length: Math.max(0, ON - effRot.onCourt.length) }).map((_, idx) => (
                    <button key={"empty-"+idx}
                      onClick={() => setSwapModal({ rotIdx:i, slotPlayer:null })}
                      style={{ background:"#ef444415", border:"1.5px dashed #ef4444",
                               borderRadius:20, padding:"5px 12px",
                               fontSize:13, fontWeight:700, color:"#ef4444", cursor:"pointer" }}>
                      + Fill spot
                    </button>
                  ))}
                </div>
                {seq && seq.on.length > 0 && (
                  <div style={{ marginTop:8, fontSize:12 }}>
                    <span style={{ color:"#22d3ee" }}>IN: {seq.on.map(name).join(", ")}</span>
                    <span style={{ color:"#555", margin:"0 8px" }}>|</span>
                    <span style={{ color:"#fb7185" }}>OUT: {seq.off.map(name).join(", ")}</span>
                  </div>
                )}
              </div>
            );
          })}

          {/* Danger zone */}
          <div style={{ marginTop:24, paddingTop:16, borderTop:"1px solid #ffffff10" }}>
            {confirmReset === "day" ? (
              <div style={{ display:"flex", gap:10 }}>
                <button onClick={() => setConfirmReset(null)} style={{
                  flex:1, padding:"10px 0", background:"#ffffff10", color:"#aaa",
                  border:"1px solid #333", borderRadius:10, fontSize:13, cursor:"pointer" }}>Cancel</button>
                <button onClick={resetDay} style={{
                  flex:1, padding:"10px 0", background:"#ef4444", color:"#fff",
                  border:"none", borderRadius:10, fontSize:13, fontWeight:700, cursor:"pointer" }}>
                  Yes, wipe the whole day
                </button>
              </div>
            ) : (
              <button onClick={() => setConfirmReset("day")} style={{
                width:"100%", padding:"10px 0",
                background:"transparent", color:"#555",
                border:"1px solid #333", borderRadius:10, fontSize:13, cursor:"pointer" }}>
                ↺ Reset whole day (games, times &amp; notes — names and format are kept)
              </button>
            )}
          </div>
        </div>
      )}

      {/* ══ TIMES VIEW ══ */}
      {view === "times" && (
        <div style={{ padding:16 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4 }}>
            <div style={{ fontSize:15, fontWeight:700 }}>Court Time Tracker</div>
            <div style={{ display:"flex", background:"#ffffff08", borderRadius:8, padding:2 }}>
              {[["game", curGame.label],["day","Whole day"]].map(([v, label]) => (
                <button key={v} onClick={() => setTimeScope(v)} style={{
                  padding:"5px 12px", fontSize:12, fontWeight:700, border:"none", borderRadius:6,
                  background: timeScope===v ? "#f97316" : "transparent",
                  color: timeScope===v ? "#000" : "#888", cursor:"pointer" }}>{label}</button>
              ))}
            </div>
          </div>
          <div style={{ fontSize:12, color:"#666", marginBottom:16 }}>
            {!scopeStarted
              ? "Start the game to track time"
              : timeScope === "game"
                ? `${game.segments.length} rotation${game.segments.length!==1?"s":""} logged${status==="paused"?" · clock paused":status==="ended"?" · final":""}`
                : `${games.length} game${games.length!==1?"s":""} · target ${fmt(scopeTarget)} each so far`}
          </div>

          {ROSTER.map(p => {
            const ms       = scopeTimes[p] || 0;
            const barPct   = scopeTarget > 0 ? Math.min(ms / (scopeTarget * 2), 1) : 0;
            const isUnder  = ms < scopeTarget * 0.85;
            const isOver   = ms > scopeTarget * 1.15;
            const isAbsent  = absent.includes(p);
            const isInjured = injured.includes(p);
            return (
              <div key={p} style={{ marginBottom:14, opacity:isAbsent?0.4:1 }}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <span style={{ fontWeight:700, fontSize:15, color:playerColor(p) }}>{name(p)}</span>
                    {isInjured && <span style={{ fontSize:10, background:"#fbbf2420", color:"#fbbf24", borderRadius:4, padding:"1px 5px" }}>⚠ INJ</span>}
                    {isAbsent  && <span style={{ fontSize:10, background:"#ef444420", color:"#ef4444", borderRadius:4, padding:"1px 5px" }}>AWAY</span>}
                    <button onClick={() => openPNote(p)} style={{
                      background:"transparent", border:"none", cursor:"pointer", padding:"0 2px",
                      fontSize:13, opacity:(playerNotes[p]||"").trim() ? 1 : 0.35 }}>📝</button>
                  </div>
                  <div style={{ fontSize:14, fontWeight:700,
                                color: scopeStarted&&isUnder?"#ef4444":isOver?"#fbbf24":"#aaa" }}>
                    {fmt(ms)}
                    {scopeStarted && <span style={{ fontSize:11, color:"#555", marginLeft:4 }}>/ {fmt(scopeTarget)}</span>}
                  </div>
                </div>
                <div style={{ height:8, background:"#ffffff0a", borderRadius:4, overflow:"hidden" }}>
                  <div style={{ height:"100%", width:`${barPct*100}%`,
                                background: scopeSegs>2&&isUnder?"#ef4444":isOver?"#fbbf24":playerColor(p),
                                borderRadius:4, transition:"width 0.5s" }}/>
                </div>
                <div style={{ position:"relative", height:8 }}>
                  <div style={{ position:"absolute", left:"50%", top:-8,
                                width:2, height:8, background:"#ffffff30" }}/>
                </div>
                {(playerNotes[p] || "").trim() && (
                  <div style={{ fontSize:11, color:"#999", fontStyle:"italic", marginTop:-2 }}>
                    📝 {playerNotes[p].trim()}
                  </div>
                )}
              </div>
            );
          })}

          {/* Export / share */}
          <button onClick={shareExport} disabled={daySegments === 0} style={{
            width:"100%", marginTop:8, padding:"13px 0",
            background: daySegments === 0 ? "#ffffff08"
              : shareStatus ? "#22d3ee" : "linear-gradient(135deg,#f97316,#fb923c)",
            color: daySegments === 0 ? "#444" : "#000",
            border:"none", borderRadius:12, fontSize:15, fontWeight:800,
            cursor: daySegments === 0 ? "default" : "pointer" }}>
            {shareStatus === "shared" ? "✓ Shared!"
              : shareStatus === "copied" ? "✓ Copied — paste into Notes"
              : shareStatus === "error" ? "✗ Couldn't copy — try again"
              : "📤 Export day summary"}
          </button>
          <div style={{ fontSize:11, color:"#666", textAlign:"center", marginTop:6 }}>
            Opens the share sheet — save to Apple Notes, Messages, email… Includes minutes per game, day totals and player notes.
          </div>

          {/* Rotation log per game */}
          {games.map((g, gi) => analyses[gi].segments.length > 0 && (
            <div key={g.id} style={{ marginTop:12, padding:14, background:"#ffffff06",
                          borderRadius:12, border:"1px solid #ffffff0a" }}>
              <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, marginBottom:8 }}>
                <span style={{ color:"#888", fontWeight:700 }}>{g.label} rotation log</span>
                <span style={{ color:"#666" }}>
                  {fmt(analyses[gi].segments.reduce((s, seg) => s + seg.dur, 0))} total
                  {gi === curIdx && status !== "ended" ? " · live" : ""}
                </span>
              </div>
              {analyses[gi].segments.map((seg, i) => (
                <div key={i} style={{ display:"flex", justifyContent:"space-between",
                                      fontSize:12, padding:"4px 0", borderBottom:"1px solid #ffffff08" }}>
                  <span style={{ color:"#666" }}>Rot {seg.rotIndex+1}</span>
                  <span style={{ color:"#aaa" }}>{fmt(seg.dur)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* ══ MATCHUP MODAL ══ */}
      {noteModal && (
        <div style={{ position:"fixed", inset:0, background:"#000000cc", zIndex:100,
                      display:"flex", alignItems:"flex-end" }}
             onClick={() => setNoteModal(null)}>
          <div style={{ background:"#1a1a2e", width:"100%", borderRadius:"20px 20px 0 0",
                        padding:24, border:"1px solid #ffffff15" }}
               onClick={e => e.stopPropagation()}>
            <div style={{ fontSize:12, color:"#888", marginBottom:4, letterSpacing:1, textTransform:"uppercase" }}>
              Matchup
            </div>
            <div style={{ fontSize:20, fontWeight:800, marginBottom:16 }}>
              <span style={{ color:playerColor(noteModal) }}>{name(noteModal)}</span>
              <span style={{ color:"#555", marginLeft:8 }}>is guarding…</span>
            </div>
            <input
              autoFocus
              value={noteDraft}
              placeholder="Opposition number, e.g. 7"
              onChange={e => setNoteDraft(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") saveNote(noteDraft); }}
              style={{ background:"#ffffff08", border:"1.5px solid #f9731670",
                       borderRadius:10, padding:"12px 14px", fontSize:18, fontWeight:700,
                       color:"#f97316", outline:"none", width:"100%", marginBottom:14 }} />
            <div style={{ display:"flex", gap:10 }}>
              <button onClick={() => saveNote("")} style={{
                flex:1, padding:"12px 0", background:"#ffffff10", color:"#888",
                border:"none", borderRadius:10, fontSize:14, cursor:"pointer" }}>Clear</button>
              <button onClick={() => saveNote(noteDraft)} style={{
                flex:2, padding:"12px 0", background:"#f97316", color:"#000",
                border:"none", borderRadius:10, fontSize:15, fontWeight:800, cursor:"pointer" }}>Save</button>
            </div>
          </div>
        </div>
      )}

      {/* ══ PLAYER NOTE MODAL ══ */}
      {pNoteModal && (
        <div style={{ position:"fixed", inset:0, background:"#000000cc", zIndex:100,
                      display:"flex", alignItems:"flex-end" }}
             onClick={() => setPNoteModal(null)}>
          <div style={{ background:"#1a1a2e", width:"100%", borderRadius:"20px 20px 0 0",
                        padding:24, border:"1px solid #ffffff15" }}
               onClick={e => e.stopPropagation()}>
            <div style={{ fontSize:12, color:"#888", marginBottom:4, letterSpacing:1, textTransform:"uppercase" }}>
              Game notes
            </div>
            <div style={{ fontSize:20, fontWeight:800, marginBottom:16 }}>
              <span style={{ color:playerColor(pNoteModal) }}>{name(pNoteModal)}</span>
            </div>
            <textarea
              autoFocus
              value={pNoteDraft}
              placeholder="e.g. great hustle on defence, work on left-hand dribble…"
              onChange={e => setPNoteDraft(e.target.value)}
              rows={4}
              style={{ background:"#ffffff08", border:"1.5px solid #f9731670",
                       borderRadius:10, padding:"12px 14px", fontSize:15, lineHeight:1.4,
                       color:"#f0f0f0", outline:"none", width:"100%", marginBottom:14,
                       resize:"none", fontFamily:"inherit" }} />
            <div style={{ display:"flex", gap:10 }}>
              <button onClick={() => savePNote("")} style={{
                flex:1, padding:"12px 0", background:"#ffffff10", color:"#888",
                border:"none", borderRadius:10, fontSize:14, cursor:"pointer" }}>Clear</button>
              <button onClick={() => savePNote(pNoteDraft)} style={{
                flex:2, padding:"12px 0", background:"#f97316", color:"#000",
                border:"none", borderRadius:10, fontSize:15, fontWeight:800, cursor:"pointer" }}>Save</button>
            </div>
          </div>
        </div>
      )}

      {/* ══ SWAP MODAL ══ */}
      {swapModal && (() => {
        const { rotIdx, slotPlayer } = swapModal;
        const currentOnCourt = effectiveRots[rotIdx]?.onCourt || [];
        const alreadyOn = slotPlayer
          ? currentOnCourt.filter(p => p !== slotPlayer)
          : currentOnCourt;
        const options   = activePlayers.filter(p => !alreadyOn.includes(p));
        const isFilling = slotPlayer === null;
        return (
          <div style={{ position:"fixed", inset:0, background:"#000000cc", zIndex:100,
                        display:"flex", alignItems:"flex-end" }}
               onClick={() => setSwapModal(null)}>
            <div style={{ background:"#1a1a2e", width:"100%", borderRadius:"20px 20px 0 0",
                          padding:24, border:"1px solid #ffffff15" }}
                 onClick={e => e.stopPropagation()}>
              <div style={{ fontSize:12, color:"#888", marginBottom:4, letterSpacing:1, textTransform:"uppercase" }}>
                Rotation {rotIdx+1} — {isFilling ? "fill empty spot" : "swap out"}
              </div>
              <div style={{ fontSize:20, fontWeight:800, marginBottom:16 }}>
                {isFilling
                  ? <span style={{ color:"#ef4444" }}>Who fills the vacant spot?</span>
                  : <><span style={{ color:playerColor(slotPlayer) }}>{name(slotPlayer)}</span>
                     <span style={{ color:"#555", marginLeft:8 }}>→ replace with</span></>
                }
              </div>
              {options.length === 0
                ? <div style={{ color:"#555", fontSize:14, marginBottom:16 }}>No available players.</div>
                : (
                  <div style={{ display:"flex", flexWrap:"wrap", gap:10, marginBottom:16 }}>
                    {options.map(p => (
                      <button key={p} onClick={() => doSwap(p)} style={{
                        background:playerColor(p)+"25", border:`2px solid ${playerColor(p)}`,
                        borderRadius:12, padding:"10px 18px",
                        color:playerColor(p), fontSize:16, fontWeight:800, cursor:"pointer" }}>{name(p)}</button>
                    ))}
                  </div>
                )
              }
              <button onClick={() => setSwapModal(null)} style={{
                width:"100%", padding:"12px 0", background:"#ffffff10",
                color:"#888", border:"none", borderRadius:10, fontSize:14, cursor:"pointer" }}>Cancel</button>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
