import { initFirebase } from "./firebase.js";
import {
  joinLobby, watchRoom, roomRefs,
  setRoomState,
  publishMyState, subscribeOppState,
  pushEvent, subscribeEvents,
  tryCleanupRoom, releaseSlot, sweepLobbySlots
} from "./netplay.js";

// --- UI
const ui = {
  matchBtn: document.getElementById("match-btn"),
  status: document.getElementById("net-status"),
  oppTitle: document.getElementById("opp-title"),
  oppCanvas: document.getElementById("opp-canvas"),
  overlay: document.getElementById("net-overlay"),
  overlayTitle: document.getElementById("net-overlay-title"),
  overlayDesc: document.getElementById("net-overlay-desc"),
  overlayTimer: document.getElementById("net-overlay-timer"),
  overlayRetry: document.getElementById("net-overlay-retry"),
  overlayClose: document.getElementById("net-overlay-close"),
};

let _overlayKind = null;

function setStatus(t){
  if(ui.status) ui.status.textContent = t;
}

function showNetOverlay({title, desc, seconds, canClose=true, canRetry=true, closeText, retryText, kind}={}){
  if(!ui.overlay) return;
  if(kind) _overlayKind = kind;
  if(ui.overlayTitle && typeof title === "string") ui.overlayTitle.textContent = title;
  if(ui.overlayDesc && typeof desc === "string") ui.overlayDesc.textContent = desc;
  if(ui.overlayTimer){
    ui.overlayTimer.textContent = (typeof seconds === "number") ? `남은 시간: ${seconds}s` : "";
  }
  if(ui.overlayRetry){
    ui.overlayRetry.style.display = canRetry ? "" : "none";
    if(typeof retryText === "string") ui.overlayRetry.textContent = retryText;
  }
  if(ui.overlayClose){
    ui.overlayClose.style.display = canClose ? "" : "none";
    if(typeof closeText === "string") ui.overlayClose.textContent = closeText;
  }
  ui.overlay.classList.add("show");
  ui.overlay.setAttribute("aria-hidden", "false");
}

function hideNetOverlay(){
  if(!ui.overlay) return;
  ui.overlay.classList.remove("show");
  ui.overlay.setAttribute("aria-hidden", "true");
  _overlayKind = null;
}

if(ui.overlayRetry){
  ui.overlayRetry.addEventListener("click", ()=>location.reload());
}
if(ui.overlayClose){
  ui.overlayClose.addEventListener("click", ()=>{ if(_overlayKind==="matching" || mode==="matching"){ cancelMatching("user"); } else { hideNetOverlay(); } });
}

setStatus("오프라인");

function comboToRocks(combo){
  const c = combo|0;
  if(c < 3) return 0;
  if(c === 3) return 1;
  if(c === 4) return 2;
  return Math.min(6, c - 2);
}

let waitTimer = null;
let waitRemain = 0;
let joinedAt = 0;
let resolved = false;
let startArmed = false;
let startTimeout = null;

function beginCountdown(seconds){
  try{ if(waitTimer) clearInterval(waitTimer); }catch{}
  waitRemain = seconds|0;
  showNetOverlay({ title: "매칭 중…", desc: "상대방을 찾는 중입니다.", seconds: waitRemain, canClose: true, canRetry: false, closeText: "매칭 취소", kind: "matching" });
  waitTimer = setInterval(()=>{
    waitRemain -= 1;
    if(waitRemain < 0) waitRemain = 0;
    // still waiting
    if(mode !== "online"){
      showNetOverlay({ title: "매칭 중…", desc: "상대방을 찾는 중입니다.", seconds: waitRemain, canClose: true, canRetry: false, closeText: "매칭 취소", kind: "matching" });
    }
    if(waitRemain <= 0 && mode !== "online"){
      try{ clearInterval(waitTimer); }catch{}
      waitTimer = null;
      // timeout -> cancel matching & cleanup signals
      cancelMatching("timeout", { silent:true });
      showNetOverlay({ title: "매칭 실패", desc: "20초 안에 상대를 찾지 못했습니다.", seconds: undefined, canClose: true, canRetry: true, closeText: "닫기" });
    }
  }, 1000);
}

function startMatching(){
  if(mode !== "offline"){
    location.reload();
    return;
  }
  if(!game){
    showNetOverlay({ title: "로딩 중…", desc: "게임 준비가 끝난 뒤 다시 눌러주세요.", canClose: true, canRetry: false });
    return;
  }
  _exitCleanedKey = null;
  _resultCleanupOnce = false;
  resolved = false;
  mode = "matching";
  setStatus("연결 중…");
  beginCountdown(20);
  bootOnline();
}

let _savedGameHooks = null;
let _resultCleanupOnce = false;

function saveGameHooks(){
  if(!game || _savedGameHooks) return;
  _savedGameHooks = {
    onComboEnd: game.onComboEnd,
    onGameOver: game.onGameOver
  };
}
function restoreGameHooks(){
  if(!game || !_savedGameHooks) return;
  try{ game.onComboEnd = _savedGameHooks.onComboEnd; }catch{}
  try{ game.onGameOver = _savedGameHooks.onGameOver; }catch{}
  _savedGameHooks = null;
}

function scheduleResultCleanup(){
  if(_resultCleanupOnce) return;
  _resultCleanupOnce = true;
  // let the result event propagate first, then cleanup signals
  setTimeout(()=>{
    bestEffortExitCleanup({ force:true });
    try{ setStatus("오프라인"); }catch{}
    mode = "offline";
  }, 1200);
}

function cancelMatching(reason="user", { silent=false } = {}){
  // stop countdown
  try{ if(waitTimer) clearInterval(waitTimer); }catch{}
  waitTimer = null;
  try{ if(startTimeout) clearTimeout(startTimeout); }catch{}
  startTimeout = null;
  startArmed = false;

  // cleanup firebase signals even if we are switching to offline
  bestEffortExitCleanup({ force:true });
  restoreGameHooks();

  // return to offline state
  mode = "offline";
  setStatus("오프라인");
  if(!silent) hideNetOverlay();
}


if(ui.matchBtn){
  ui.matchBtn.addEventListener("click", startMatching);
}

// --- Online flow
function stableLobbyId(){
  const s = location.origin + location.pathname;
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for(let i=0;i<s.length;i++){
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return "suika_" + (h>>>0).toString(36);
}

let fb=null, db=null, api=null;
let lobbyId="", roomId="", mySlot=null, pid="";
let hbTimer=null;
let refs=null;
let roomUnsub=null, oppUnsub=null, evUnsub=null;
let publishTimer=null;
let sweepTimer=null;
let mode="offline";

// game instance
let game=null;

// Opp render
const oppCtx = ui.oppCanvas ? ui.oppCanvas.getContext("2d") : null;
function drawOpp(state){
  if(!oppCtx || !ui.oppCanvas) return;
  const cv = ui.oppCanvas;
  oppCtx.clearRect(0,0,cv.width,cv.height);

  // background
  oppCtx.fillStyle = "rgba(255,255,255,0.35)";
  oppCtx.fillRect(0,0,cv.width,cv.height);

  if(!state || !state.w || !state.h) return;

  const shapes = window.SHAPES || [];

  // --- Fit inside the preview canvas with padding (prevents bottom clipping)
  const pad = 6;
  const effW = state.w;
  const effH = state.h + 8; // allow a tiny extra space for the cup bottom (bottomY offset)

  const sx = (cv.width - pad*2) / effW;
  const sy = (cv.height - pad*2) / effH;
  const s = Math.min(sx, sy);

  const ox = (cv.width - effW * s) / 2;
  const oy = (cv.height - effH * s) / 2;

  // Draw opponent bowl outline + danger line (same geometry as the real physics cup)
  drawOppCup(oppCtx, cv, state, s, ox, oy);

  if(!state.bodies) return;

  for(const b of state.bodies){
    const x = b.x * s + ox;
    const y = b.y * s + oy;
    const a = b.a || 0;
    const isRock = !!b.r;

    let size = (shapes[b.i]?.size || (shapes[0]?.size || 14)) * s;
    if(size < 2) size = 2;
    if(isRock) size *= 2;

    oppCtx.save();
    oppCtx.translate(x,y);
    oppCtx.rotate(a);

    if(isRock){
      drawRock(oppCtx, size);
    }else{
      const type = shapes[b.i]?.type || "circle";
      const color = shapes[b.i]?.color || "#FF6B6B";
      drawShape(oppCtx, type, color, size);
    }

    oppCtx.restore();
  }
}

function drawOppCup(ctx, cv, state, s, ox, oy){
  // Same parameterization as ShapeGame.setupPhysics(index.html).
  // Plus: draw inside padding/letterbox so the bottom line doesn't get clipped in the preview.
  const w = state.w;
  const h = state.h;
  const inset = 8;
  const centerX = w / 2;
  const radiusX = (w / 2) - inset;
  const curveTopY = h * 0.6;
  const bottomY = h + 4; // keep consistent with the main physics cup
  const radiusY = bottomY - curveTopY;

  // danger line: DOM uses 35px from the top in the main UI
  const padX = inset * s;
  const dangerY = 35 * s;

  ctx.save();
  ctx.strokeStyle = "rgba(255,107,107,0.6)";
  ctx.lineWidth = 2;
  ctx.setLineDash([6,6]);
  ctx.beginPath();
  ctx.moveTo(ox + padX, oy + dangerY);
  ctx.lineTo(ox + (w * s) - padX, oy + dangerY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Cup outline: left wall -> curved bottom -> right wall
  const leftX = centerX - radiusX;
  const rightX = centerX + radiusX;

  ctx.strokeStyle = "rgba(180,160,140,0.85)";
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  ctx.beginPath();
  ctx.moveTo(ox + leftX * s, oy + 0);
  ctx.lineTo(ox + leftX * s, oy + curveTopY * s);

  const segments = 24;
  for(let i=0;i<=segments;i++){
    const ang = Math.PI - (i / segments) * Math.PI;
    const x = centerX + radiusX * Math.cos(ang);
    const y = curveTopY + radiusY * Math.sin(ang);
    ctx.lineTo(ox + x * s, oy + y * s);
  }

  ctx.lineTo(ox + rightX * s, oy + 0);
  ctx.stroke();
  ctx.restore();
}


function drawShape(ctx, type, color, size){
  ctx.fillStyle = color;
  ctx.strokeStyle = "rgba(0,0,0,0.25)";
  ctx.lineWidth = Math.max(1, size * 0.12);

  ctx.beginPath();
  if(type === "circle" || type === "bigcircle"){
    ctx.arc(0,0,size,0,Math.PI*2);
  }else if(type === "triangle"){
    poly(ctx, 3, size);
  }else if(type === "pentagon"){
    poly(ctx, 5, size);
  }else if(type === "hexagon"){
    poly(ctx, 6, size);
  }else if(type === "square"){
    ctx.rect(-size*0.8,-size*0.8,size*1.6,size*1.6);
  }else if(type === "rectangle"){
    ctx.rect(-size*1.1,-size*0.6,size*2.2,size*1.2);
  }else if(type === "diamond"){
    ctx.moveTo(0,-size);
    ctx.lineTo(size*0.75,0);
    ctx.lineTo(0,size);
    ctx.lineTo(-size*0.75,0);
    ctx.closePath();
  }else if(type === "isoceles"){
    ctx.moveTo(0,-size*1.3);
    ctx.lineTo(size*0.7,size*0.7);
    ctx.lineTo(-size*0.7,size*0.7);
    ctx.closePath();
  }else{
    ctx.arc(0,0,size,0,Math.PI*2);
  }

  ctx.fill();
  ctx.stroke();
}

function poly(ctx, n, r){
  for(let i=0;i<n;i++){
    const ang = (Math.PI*2*i)/n - Math.PI/2;
    const x = Math.cos(ang)*r;
    const y = Math.sin(ang)*r;
    if(i===0) ctx.moveTo(x,y);
    else ctx.lineTo(x,y);
  }
  ctx.closePath();
}

function drawRock(ctx, size){
  ctx.fillStyle = "#7f8c8d";
  ctx.strokeStyle = "#2d3436";
  ctx.lineWidth = Math.max(1, size * 0.18);

  const r = size * 0.95;
  ctx.beginPath();
  for(let i=0;i<6;i++){
    const ang = (Math.PI*2*i)/6;
    const rr = r * (0.82 + (i%2)*0.12);
    const x = Math.cos(ang)*rr;
    const y = Math.sin(ang)*rr;
    if(i===0) ctx.moveTo(x,y);
    else ctx.lineTo(x,y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // x_x face
  ctx.strokeStyle = "#1f1f1f";
  ctx.lineWidth = Math.max(1, size * 0.16);
  const eg = size * 0.33;
  const ey = -size * 0.05;
  const cross = size * 0.14;
  const drawX = (cx, cy) => {
    ctx.beginPath();
    ctx.moveTo(cx - cross, cy - cross);
    ctx.lineTo(cx + cross, cy + cross);
    ctx.moveTo(cx - cross, cy + cross);
    ctx.lineTo(cx + cross, cy - cross);
    ctx.stroke();
  };
  drawX(-eg, ey);
  drawX(eg, ey);

  ctx.beginPath();
  ctx.moveTo(-size*0.22, size*0.32);
  ctx.lineTo(size*0.22, size*0.32);
  ctx.stroke();
}

async function enterRoom(joined){
  roomId = joined.roomId;
  mySlot = joined.slot;
  pid = joined.pid;
  hbTimer = joined.hbTimer;
  joinedAt = Date.now();

  refs = roomRefs({db, api, roomId});

  roomUnsub?.();
  roomUnsub = watchRoom({ db, api, roomId, onRoom: onRoomUpdate });

  oppUnsub?.();
  oppUnsub = subscribeOppState({ api, statesRef: refs.statesRef, pid, onOpp: ({state})=>{
    if(ui.oppTitle){
      const score = state?.score ?? 0;
      ui.oppTitle.textContent = `상대 (점수 ${score})`;
    }
    // win detection
    if(state?.over && !resolved){
      resolved = true;
      try{ if(game) game.canDrop = false; }catch{}
      showNetOverlay({ title: "승리!", desc: "상대가 게임오버 되었습니다.", seconds: undefined, canClose: true, canRetry: true });
      scheduleResultCleanup();
    }
    drawOpp(state);
  }});

  evUnsub?.();
  evUnsub = subscribeEvents({ api, eventsRef: refs.eventsRef, pid, onEvent: onEventRecv });

  // publish loop
  if(publishTimer) clearInterval(publishTimer);
  publishTimer = setInterval(()=>{
    if(!game || mode === "offline") return;
    publishMyState({ api, statesRef: refs.statesRef, pid, state: game.getNetState() }).catch(()=>{});
  }, 120);

  // hook combo -> attack & gameover -> result
  if(game){
    saveGameHooks();
    game.onComboEnd = (cnt)=>{
      if(mode === "offline" || !refs || !refs.eventsRef) return;
      const n = comboToRocks(cnt);
      if(n <= 0) return;
      pushEvent({ api, eventsRef: refs.eventsRef, event: { from: pid, kind: "rocks", payload: { n } } }).catch(()=>{});
    };
    game.onGameOver = ()=>{
      if(mode === "offline" || !refs || !refs.eventsRef) return;
      if(!resolved){
        resolved = true;
        showNetOverlay({ title: "패배", desc: "내 게임오버!", seconds: undefined, canClose: true, canRetry: true });
      }
      pushEvent({ api, eventsRef: refs.eventsRef, event: { from: pid, kind: "over", payload: { score: game?.score ?? 0 } } }).catch(()=>{});
      scheduleResultCleanup();    };
  }
}

function onRoomUpdate(room){
  if(mode === "offline") return;
  if(!room || !room.meta){
    setStatus("방 없음(오프라인)");
    return;
  }

  const meta = room.meta;
  const players = room.players || {};
  const ids = Object.keys(players);

  if(ui.oppTitle) ui.oppTitle.textContent = ids.length >= 2 ? "상대" : "상대 (연결 대기…)";

  if(ids.length >= 2){
    setStatus("연결됨");

    // stop matching countdown once connected
    try{ if(waitTimer) clearInterval(waitTimer); }catch{}
    waitTimer = null;
    waitRemain = 0;

    // request a synchronized start window if still open
    if(meta.state === "open" || !meta.state){
      api.runTransaction(refs.metaRef, (m)=>{
        if(!m) return m;
        const st = m.state || "open";
        if(st !== "open") return m;
        m.state = "starting";
        m.startAt = Date.now() + 900;
        m.updatedAt = Date.now();
        return m;
      }).catch(()=>{});

      // until the transaction propagates, treat it as starting locally
      if(!startArmed){
        startArmed = true;
        try{ if(game) game.canDrop = false; }catch{}
        showNetOverlay({ title: "연결되었습니다!", desc: "게임 시작", seconds: undefined, canClose: false, canRetry: false, kind: "starting" });
        try{ if(startTimeout) clearTimeout(startTimeout); }catch{}
        startTimeout = setTimeout(()=>{
          startTimeout = null;
          hideNetOverlay();
          try{ window.__shapeGame?.restart?.(); }catch{}
          try{ if(game) game.canDrop = true; }catch{}
          setRoomState({ api, metaRef: refs.metaRef }, "playing").catch(()=>{});
          mode = "online";
        }, 900);
      }
      return;
    }

    if(meta.state === "starting"){
      const startAt = (meta.startAt || (Date.now() + 600))|0;
      if(!startArmed){
        startArmed = true;
        try{ if(game) game.canDrop = false; }catch{}
        showNetOverlay({ title: "연결되었습니다!", desc: "게임 시작", seconds: undefined, canClose: false, canRetry: false, kind: "starting" });
        try{ if(startTimeout) clearTimeout(startTimeout); }catch{}
        const ms = Math.max(0, startAt - Date.now());
        startTimeout = setTimeout(()=>{
          startTimeout = null;
          hideNetOverlay();
          try{ window.__shapeGame?.restart?.(); }catch{}
          try{ if(game) game.canDrop = true; }catch{}
          setRoomState({ api, metaRef: refs.metaRef }, "playing").catch(()=>{});
          mode = "online";
        }, ms);
      }
      return;
    }

    // playing (or anything else): hide overlays and allow play
    try{ if(startTimeout) clearTimeout(startTimeout); }catch{}
    startTimeout = null;
    startArmed = false;
    hideNetOverlay();
    try{ if(game) game.canDrop = true; }catch{}
    mode = "online";
    return;
  }

  // not connected
  setStatus("연결 대기…");

  // if we were arming start, cancel it
  try{ if(startTimeout) clearTimeout(startTimeout); }catch{}
  startTimeout = null;
  startArmed = false;
}

function onEventRecv({key, ev}){
  if(!ev) return;
  // ignore stale events from previous occupants
  if(joinedAt && ev.t && ev.t < joinedAt - 5000){
    try{ api.remove(api.child(refs.eventsRef, key)).catch(()=>{}); }catch{}
    return;
  }
  if(ev.kind === "rocks"){
    const n = Math.max(0, Math.min(12, (ev.payload && ev.payload.n) || 0));
    try{ game?.dropRocks?.(n); }catch{}
  }

  if(ev.kind === "over"){
    if(!resolved){
      resolved = true;
      try{ if(game) game.canDrop = false; }catch{}
      showNetOverlay({ title: "승리!", desc: "상대가 게임오버 되었습니다.", seconds: undefined, canClose: true, canRetry: true });
       scheduleResultCleanup();
    }
  }

  // consume immediately to avoid leaving logs
  try{ api.remove(api.child(refs.eventsRef, key)).catch(()=>{}); }catch{}
}

async function bootOnline(){
  if(!game) return;
  if(mode !== "matching") return;

  try{
    fb = initFirebase();
    db = fb.db;
    api = fb.api;
  }catch(e){
    mode = "offline";
    setStatus("오프라인");
    showNetOverlay({ title: "연결 실패", desc: "Firebase 설정이 없거나 잘못되었습니다.", seconds: undefined, canClose: true, canRetry: true });
    return;
  }

  try{
    lobbyId = stableLobbyId();
    // sweep old rooms/slots periodically so signals don't linger
    try{ await sweepLobbySlots({db, api, lobbyId, maxTeams: 10}); }catch{}
    sweepTimer = setInterval(()=>{ try{ sweepLobbySlots({db, api, lobbyId, maxTeams:10}).catch(()=>{}); }catch{} }, 20000);

    setStatus("연결 중…");

    const joined = await joinLobby({ db, api, lobbyId, name: "Player", maxTeams: 10 });
    await enterRoom(joined);

    setStatus("연결 대기…");
  }catch(e){
    mode = "offline";
    setStatus("오프라인");
    showNetOverlay({ title: "연결 실패", desc: "온라인 연결에 실패했습니다. (Firebase 설정 또는 네트워크 확인)", seconds: undefined, canClose: true, canRetry: true });
  }
}

// --- Cleanup: remove my nodes, then delete room if empty
let _exitCleanedKey = null;
function bestEffortExitCleanup({ force=false } = {}){
  const rid = roomId;
  const lid = lobbyId;
  const slot = mySlot;
  const _refs = refs;
  const _pid = pid;
  const key = rid ? `room:${rid}` : (lid ? `lobby:${lid}:slot:${slot}` : "none");
  if(!force && _exitCleanedKey === key) return;
  _exitCleanedKey = key;

  try{ if(publishTimer) clearInterval(publishTimer); }catch{}
  try{ if(sweepTimer) clearInterval(sweepTimer); }catch{}
  try{ if(hbTimer) clearInterval(hbTimer); }catch{}

  try{ roomUnsub?.(); }catch{}
  try{ oppUnsub?.(); }catch{}
  try{ evUnsub?.(); }catch{}

  if(db && api && (force || mode !== "offline")){
    // 1) 내 노드 먼저 제거(즉시 정리 시도)
    try{ if(_refs?.playersRef && _pid) api.remove(api.child(_refs.playersRef, _pid)).catch(()=>{}); }catch{}
    try{ if(_refs?.statesRef && _pid) api.remove(api.child(_refs.statesRef, _pid)).catch(()=>{}); }catch{}

    // 2) room cleanup: 빈 방이면 meta/players/states/events 삭제 (best-effort, 재시도)
    if(rid){
      try{ setTimeout(()=>{ tryCleanupRoom({ db, api, roomId: rid }).catch(()=>{}); }, 250); }catch{}
      try{ setTimeout(()=>{ tryCleanupRoom({ db, api, roomId: rid }).catch(()=>{}); }, 2500); }catch{}
      try{ setTimeout(()=>{ tryCleanupRoom({ db, api, roomId: rid }).catch(()=>{}); }, 9000); }catch{}
    }

    // 3) lobby slot 해제(가능하면)
    try{ if(lid && slot!==undefined && slot!==null) releaseSlot({ db, api, lobbyId: lid, slot }).catch(()=>{}); }catch{}
    // prune lobby mm if empty
    try{ if(lid) releaseSlot({ db, api, lobbyId: lid, slot: null }).catch(()=>{}); }catch{}
  }

  // local session reset (allows re-matching in the same tab)
  refs = null;
  roomId = null;
  pid = null;
  mySlot = null;
  hbTimer = null;
}

window.addEventListener("beforeunload", bestEffortExitCleanup);
window.addEventListener("pagehide", bestEffortExitCleanup);
document.addEventListener("visibilitychange", ()=>{
  if(document.visibilityState === "hidden") bestEffortExitCleanup();
});

// If game over and user closes overlay/reloads, cleanup will run via unload.
window.addEventListener('shapeGameReady', (e)=>{
  game = e?.detail?.game || window.__shapeGame || null;
  // 온라인은 "매칭" 버튼을 눌렀을 때만 시작
  setStatus("오프라인");
});

// In case event was dispatched before this module loaded
if(window.__shapeGame){
  game = window.__shapeGame;
  setStatus("오프라인");
}