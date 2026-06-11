import { useState, useEffect, useRef } from "react";

// Players are internal ids only. Display names are entered in Setup and
// stored on the device (localStorage) — no real names live in this code
// or in the published app.
const PLAYERS = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"];
const defaultName = p => `Player ${PLAYERS.indexOf(p) + 1}`;

const DEFAULT_ROTATIONS = [
  { id: 1, onCourt: ["p1", "p2", "p3", "p4"] },
  { id: 2, onCourt: ["p1", "p2", "p6", "p7"] },
  { id: 3, onCourt: ["p5", "p2", "p3", "p6"] },
  { id: 4, onCourt: ["p5", "p3", "p4", "p8"] },
  { id: 5, onCourt: ["p1", "p4", "p7", "p8"] },
  { id: 6, onCourt: ["p5", "p6", "p7", "p8"] },
];

const KEY_LINEUP = "u8_lineup_v4";
const KEY_GAME   = "u8_game_v4";
const KEY_NAMES  = "u8_names_v1";

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

// ── Game clock model ─────────────────────────────────────────────
// The game is a log of timestamped events:
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

const COLORS = ["#f97316","#22d3ee","#a78bfa","#34d399","#fb7185","#fbbf24","#60a5fa","#f472b6"];
function playerColor(p) { return COLORS[PLAYERS.indexOf(p) % COLORS.length]; }

export default function App() {
  // Lineup state
  const [rotations,  setRotations]  = useState(DEFAULT_ROTATIONS);
  const [names,      setNames]      = useState({});
  const [absent,     setAbsent]     = useState([]);
  const [injured,    setInjured]    = useState([]);
  const [saveStatus, setSaveStatus] = useState(null);
  const [hasSaved,   setHasSaved]   = useState(false);
  const [loaded,     setLoaded]     = useState(false);

  // Game state — single source of truth is the event log
  const [gameLog, setGameLog] = useState([]);

  // UI
  const [view,      setView]      = useState("game");
  const [swapModal, setSwapModal] = useState(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [now,       setNow]       = useState(Date.now());
  const [dragInfo,  setDragInfo]  = useState(null); // {rotIdx, player} while dragging
  const wakeLockRef = useRef(null);
  const dragRef     = useRef(null);

  // Derived
  const name          = p => (names[p] || "").trim() || defaultName(p);
  const unavailable   = [...absent, ...injured];
  const activePlayers = PLAYERS.filter(p => !unavailable.includes(p));
  const effectiveRots = applyAvailability(rotations, unavailable);
  const sequence      = buildSequence(effectiveRots, activePlayers);
  const game          = analyzeGame(gameLog, sequence, PLAYERS, now);
  const { status }    = game;            // idle | running | paused | ended
  const currentRot    = game.rotIndex;
  const rot           = sequence[currentRot];
  const courtTimes    = game.times;
  const TARGET        = 5 * 60 * 1000;
  const timerPct      = Math.min(game.sinceSub / TARGET, 1);
  const overdue       = status === "running" && game.sinceSub > TARGET;
  const gameStarted   = gameLog.length > 0;

  // ── Load everything on mount ──────────────────────────────────
  useEffect(() => {
    const lineup = retrieve(KEY_LINEUP);
    if (lineup?.rotations) { setRotations(lineup.rotations); setHasSaved(true); }

    const savedNames = retrieve(KEY_NAMES);
    if (savedNames) setNames(savedNames);

    const saved = retrieve(KEY_GAME);
    if (saved) {
      if (saved.gameLog) setGameLog(saved.gameLog);
      if (saved.absent)  setAbsent(saved.absent);
      if (saved.injured) setInjured(saved.injured);
    }
    setLoaded(true);
  }, []);

  // ── Auto-save game state on every change ─────────────────────
  useEffect(() => {
    if (!loaded) return;
    persist(KEY_GAME, { gameLog, absent, injured });
  }, [loaded, gameLog, absent, injured]);

  // ── Auto-save player names ────────────────────────────────────
  useEffect(() => {
    if (!loaded) return;
    persist(KEY_NAMES, names);
  }, [loaded, names]);

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

  // ── Lineup save / reset (manual) ──────────────────────────────
  function saveLineup() {
    try {
      persist(KEY_LINEUP, { rotations });
      setSaveStatus("saved");
      setHasSaved(true);
    } catch (e) {
      setSaveStatus("error");
    }
    setTimeout(() => setSaveStatus(null), 2500);
  }
  function resetLineup() {
    setRotations(DEFAULT_ROTATIONS);
    forget(KEY_LINEUP);
    setHasSaved(false);
  }

  // ── Game controls ─────────────────────────────────────────────
  function addEvent(ev) { setGameLog(prev => [...prev, { ...ev, ts: Date.now() }]); }

  function startGame()  { setGameLog([{ type: "start", ts: Date.now(), rotIndex: 0 }]); }
  function pauseGame()  { addEvent({ type: "pause" }); }
  function resumeGame() { addEvent({ type: "resume" }); }
  function endGame()    { addEvent({ type: "end" }); }
  function doSub() {
    if (currentRot >= sequence.length - 1) return;
    const evs = [];
    if (status === "paused") evs.push({ type: "resume", ts: Date.now() });
    evs.push({ type: "sub", ts: Date.now(), rotIndex: currentRot + 1 });
    setGameLog(prev => [...prev, ...evs]);
  }
  function undoSub() {
    // Remove everything back to (and including) the most recent 'sub' event
    const idx = gameLog.map(e => e.type).lastIndexOf("sub");
    if (idx <= 0) return;
    setGameLog(gameLog.slice(0, idx));
  }
  function resetGame() {
    setGameLog([]);
    setConfirmReset(false);
    forget(KEY_GAME);
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
    setRotations(prev => prev.map((r, i) => {
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
    setRotations(prev => prev.map((r, i) => {
      if (i !== rotIdx) return r;
      if (slotPlayer === null) return { ...r, onCourt: [...r.onCourt, newPlayer] };
      return { ...r, onCourt: r.onCourt.map(p => p === slotPlayer ? newPlayer : p) };
    }));
    setSwapModal(null);
  }

  const canSub  = (status === "running" || status === "paused") && currentRot < sequence.length - 1;
  const canUndo = (status === "running" || status === "paused") && gameLog.some(e => e.type === "sub");

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
          U8 Basketball
        </div>
        <div style={{ fontSize:22, fontWeight:800, marginTop:2, display:"flex", alignItems:"center", gap:10 }}>
          Rotation Manager
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
          {rot && (
            <div style={{ background:"linear-gradient(135deg,#1e1e3f,#1a1a2e)",
                          borderRadius:16, padding:20, border:"1px solid #ffffff15", marginBottom:16 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
                <div>
                  <div style={{ fontSize:10, color:"#888", letterSpacing:2, textTransform:"uppercase" }}>Rotation</div>
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
                                             borderRadius:20, padding:"4px 12px", fontSize:14, fontWeight:600, color:playerColor(p)+"cc" }}>{name(p)}</span>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ height:1, background:"#ffffff10", margin:"12px 0" }}/>

              <div>
                <div style={{ fontSize:10, letterSpacing:2, color:"#aaa", marginBottom:8, textTransform:"uppercase" }}>
                  On Court Now
                  {rot.onCourt.length < 4 && (
                    <span style={{ marginLeft:8, color:"#ef4444" }}>({rot.onCourt.length}/4) — tap + to fill</span>
                  )}
                </div>
                <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
                  {rot.onCourt.map(p => (
                    <span key={p} style={{ background:playerColor(p), color:"#000",
                                           borderRadius:20, padding:"5px 14px", fontSize:14, fontWeight:800 }}>{name(p)}</span>
                  ))}
                  {Array.from({ length: Math.max(0, 4 - rot.onCourt.length) }).map((_, i) => (
                    <button key={"empty-"+i}
                      onClick={() => setSwapModal({ rotIdx:currentRot, slotPlayer:null })}
                      style={{ background:"#ef444415", border:"1.5px dashed #ef4444",
                               borderRadius:20, padding:"5px 14px", fontSize:14,
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
                    <div key={p} style={{ fontSize:13, color:"#fb7185", fontWeight:700 }}>{name(p)}</div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Sub controls */}
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

          {/* End game */}
          {(status === "running" || status === "paused") && (
            <button onClick={endGame} style={{
              width:"100%", marginTop:10, padding:"12px 0",
              background:"#ef444420", color:"#ef4444",
              border:"1px solid #ef444460", borderRadius:12, fontSize:14, fontWeight:700, cursor:"pointer" }}>
              ■ End Game (final whistle)
            </button>
          )}

          {status === "ended" && (
            <div style={{ marginTop:16, padding:16, background:"#22d3ee10",
                          border:"1px solid #22d3ee40", borderRadius:12, textAlign:"center" }}>
              <div style={{ fontSize:15, fontWeight:800, color:"#22d3ee" }}>🏀 Game over!</div>
              <div style={{ fontSize:12, color:"#888", marginTop:4 }}>
                Court times are frozen — check the ⏱ Time tab.
              </div>
            </div>
          )}

          {gameStarted && (
            confirmReset ? (
              <div style={{ display:"flex", gap:10, marginTop:10 }}>
                <button onClick={() => setConfirmReset(false)} style={{
                  flex:1, padding:"10px 0", background:"#ffffff10", color:"#aaa",
                  border:"1px solid #333", borderRadius:10, fontSize:13, cursor:"pointer" }}>Cancel</button>
                <button onClick={resetGame} style={{
                  flex:1, padding:"10px 0", background:"#ef4444", color:"#fff",
                  border:"none", borderRadius:10, fontSize:13, fontWeight:700, cursor:"pointer" }}>
                  Yes, wipe game data
                </button>
              </div>
            ) : (
              <button onClick={() => setConfirmReset(true)} style={{
                width:"100%", marginTop:10, padding:"10px 0",
                background:"transparent", color:"#555",
                border:"1px solid #333", borderRadius:10, fontSize:13, cursor:"pointer" }}>
                ↺ Reset Game
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
          <div style={{ fontSize:15, fontWeight:700, marginBottom:4 }}>Player Names</div>
          <div style={{ fontSize:12, color:"#666", marginBottom:12 }}>
            Names are saved on this phone only — never published anywhere
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:24 }}>
            {PLAYERS.map(p => (
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
            {PLAYERS.map(p => {
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
            <div style={{ fontSize:15, fontWeight:700 }}>Rotation Order</div>
            <div style={{ display:"flex", gap:8, alignItems:"center" }}>
              {hasSaved && (
                <button onClick={resetLineup} style={{
                  fontSize:11, padding:"5px 10px", background:"#ffffff08",
                  color:"#666", border:"1px solid #333", borderRadius:8, cursor:"pointer" }}>↺ Reset</button>
              )}
              <button onClick={saveLineup} style={{
                fontSize:13, padding:"6px 16px", fontWeight:700, border:"none",
                background: saveStatus==="saved"?"#22d3ee":saveStatus==="error"?"#ef4444":"#f97316",
                color: saveStatus==="error"?"#fff":"#000",
                borderRadius:8, cursor:"pointer" }}>
                {saveStatus==="saved" ? "✓ Saved!" : saveStatus==="error" ? "✗ Try again" : "💾 Save Lineup"}
              </button>
            </div>
          </div>
          <div style={{ fontSize:12, color:"#666", marginBottom:12 }}>
            ↑↓ reorder rotations · tap player to swap · hold &amp; drag a player along the row to line up her colour · save to keep after restart
          </div>

          {rotations.map((rotRow, i) => {
            const effRot = effectiveRots[i];
            const seq    = sequence[i];
            return (
              <div key={rotRow.id} style={{ background:"#ffffff08", borderRadius:12, padding:14,
                                         marginBottom:10, border:"1px solid #ffffff0a" }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <div style={{ fontSize:12, color:"#888" }}>
                    Rotation {i+1}
                    {effRot.onCourt.length < 4 && (
                      <span style={{ marginLeft:8, color:"#ef4444", fontSize:11 }}>
                        ⚠ {effRot.onCourt.length}/4 players
                      </span>
                    )}
                  </div>
                  <div style={{ display:"flex", gap:4 }}>
                    {i > 0 && (
                      <button onClick={() => { const r=[...rotations]; [r[i-1],r[i]]=[r[i],r[i-1]]; setRotations(r); }}
                        style={{ background:"#ffffff15", border:"none", color:"#fff",
                                 borderRadius:6, padding:"3px 8px", cursor:"pointer" }}>↑</button>
                    )}
                    {i < rotations.length-1 && (
                      <button onClick={() => { const r=[...rotations]; [r[i],r[i+1]]=[r[i+1],r[i]]; setRotations(r); }}
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
                  {Array.from({ length: Math.max(0, 4 - effRot.onCourt.length) }).map((_, idx) => (
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
        </div>
      )}

      {/* ══ TIMES VIEW ══ */}
      {view === "times" && (
        <div style={{ padding:16 }}>
          <div style={{ fontSize:15, fontWeight:700, marginBottom:4 }}>Court Time Tracker</div>
          <div style={{ fontSize:12, color:"#666", marginBottom:16 }}>
            {!gameStarted
              ? "Start the game to track time"
              : `${game.segments.length} rotation${game.segments.length!==1?"s":""} logged${status==="paused"?" · clock paused":status==="ended"?" · final":""}`}
          </div>

          {PLAYERS.map(p => {
            const ms       = courtTimes[p] || 0;
            const barPct   = Math.min(ms / (30*60*1000), 1);
            const isUnder  = ms < 15*60*1000 * 0.85;
            const isOver   = ms > 15*60*1000 * 1.15;
            const isAbsent  = absent.includes(p);
            const isInjured = injured.includes(p);
            return (
              <div key={p} style={{ marginBottom:14, opacity:isAbsent?0.4:1 }}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <span style={{ fontWeight:700, fontSize:15, color:playerColor(p) }}>{name(p)}</span>
                    {isInjured && <span style={{ fontSize:10, background:"#fbbf2420", color:"#fbbf24", borderRadius:4, padding:"1px 5px" }}>⚠ INJ</span>}
                    {isAbsent  && <span style={{ fontSize:10, background:"#ef444420", color:"#ef4444", borderRadius:4, padding:"1px 5px" }}>AWAY</span>}
                  </div>
                  <div style={{ fontSize:14, fontWeight:700,
                                color: gameStarted&&isUnder?"#ef4444":isOver?"#fbbf24":"#aaa" }}>
                    {fmt(ms)}
                    {gameStarted && <span style={{ fontSize:11, color:"#555", marginLeft:4 }}>/ 15:00</span>}
                  </div>
                </div>
                <div style={{ height:8, background:"#ffffff0a", borderRadius:4, overflow:"hidden" }}>
                  <div style={{ height:"100%", width:`${barPct*100}%`,
                                background: game.segments.length>2&&isUnder?"#ef4444":isOver?"#fbbf24":playerColor(p),
                                borderRadius:4, transition:"width 0.5s" }}/>
                </div>
                <div style={{ position:"relative", height:8 }}>
                  <div style={{ position:"absolute", left:"50%", top:-8,
                                width:2, height:8, background:"#ffffff30" }}/>
                </div>
              </div>
            );
          })}

          {game.segments.length > 0 && (
            <div style={{ marginTop:12, padding:14, background:"#ffffff06",
                          borderRadius:12, border:"1px solid #ffffff0a" }}>
              <div style={{ fontSize:12, color:"#888", marginBottom:8 }}>Rotation Log</div>
              {game.segments.map((seg, i) => (
                <div key={i} style={{ display:"flex", justifyContent:"space-between",
                                      fontSize:12, padding:"4px 0", borderBottom:"1px solid #ffffff08" }}>
                  <span style={{ color:"#666" }}>Rot {seg.rotIndex+1}</span>
                  <span style={{ color:"#aaa" }}>{fmt(seg.dur)}</span>
                </div>
              ))}
            </div>
          )}
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
