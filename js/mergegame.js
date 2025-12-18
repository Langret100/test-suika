// MergeGame (Matter.js 기반 도형 합치기)
// - 제거 시 같이 지울 요소: index.html의 Matter.js CDN 스크립트, cvNext(다음 도형) 사용, 상대 렌더링(mergegame.drawOpponent)
/* eslint-disable no-unused-vars */

export const SHAPES = [
  { name: "작은원", type: "circle",    color: "#FF6B6B", size: 14 },
  { name: "삼각형", type: "triangle",  color: "#FECA57", size: 22 },
  { name: "이등변삼각형", type: "isoceles", color: "#48DBFB", size: 31 },
  { name: "사각형", type: "square",    color: "#1DD1A1", size: 41 },
  { name: "직사각형", type: "rectangle", color: "#5F27CD", size: 52 },
  { name: "오각형", type: "pentagon",  color: "#FF9FF3", size: 64 },
  { name: "육각형", type: "hexagon",   color: "#54A0FF", size: 78 },
  { name: "팔각형", type: "octagon",   color: "#00D2D3", size: 94 },
];

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }
function randInt(rng, a, b){ return a + Math.floor(rng() * (b - a + 1)); }
function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ensureMatter(){
  if(typeof window === "undefined" || !window.Matter){
    throw new Error("Matter.js가 로드되지 않았습니다. index.html에 Matter CDN 스크립트가 필요합니다.");
  }
  return window.Matter;
}

function dist2(a,b,c,d){ const dx=a-c, dy=b-d; return dx*dx+dy*dy; }

export class MergeGame {
  /**
   * @param {object} opts
   * @param {HTMLCanvasElement} opts.canvas - 메인 캔버스
   * @param {(n:number)=>void} [opts.onAttack] - 콤보(>=3) 확정 시 호출(상대 짱돌 n개)
   * @param {number} [opts.seed]
   */
  constructor({canvas, onAttack=null, seed=null}){
    this.cv = canvas;
    this.ctx = canvas.getContext("2d");
    this.onAttack = onAttack;
    this.seed = (seed ?? ((Math.random()*2**32)>>>0)) >>> 0;
    this.rng = mulberry32(this.seed || 1);

    this.score = 0;
    this.level = 1;
    this.dead = false;

    this.width = canvas.width;
    this.height = canvas.height;

    this.M = ensureMatter();
    this.engine = this.M.Engine.create({ positionIterations: 10, velocityIterations: 10 });
    this.world = this.engine.world;
    this.engine.world.gravity.y = 1.0;

    this._mergingPairs = new Set();
    this._rocks = new Set(); // body.id set
    this._bodies = []; // {body, shapeIndex, id, hasLanded, isRock}
    this._comboCount = 0;
    this._lastMergeAt = 0;
    this._comboFinalizeTimer = null;

    this._setupBounds();

    // collision handler
    this.M.Events.on(this.engine, "collisionStart", (e)=>{
      for(const pair of e.pairs){
        this._handleCollision(pair.bodyA, pair.bodyB);
      }
    });

    // spawn queue
    this.currentShapeIndex = 0;
    this.nextShapeIndex = this._randShapeIndex();
    this._generateNextShape();
    this._generateNextShape();

    // drop state
    this.dropX = this.width/2;
    this.canDrop = true;
    this._dangerY = Math.max(36, this.height * 0.08); // 간단 위험선

    // for external render
    this.lastMergePos = null;
  }

  resizeToCanvas(){
    // canvas size가 바뀌었을 때 호출 가능
    this.width = this.cv.width;
    this.height = this.cv.height;
    // world 재구성(간단): 기존 정적 바디 제거 후 재생성
    const all = this.M.Composite.allBodies(this.world);
    for(const b of all){
      if(b.isStatic) this.M.Composite.remove(this.world, b);
    }
    this._setupBounds();
    this.dropX = this.width/2;
    this._dangerY = Math.max(36, this.height * 0.08);
  }

  reset(){
    // world reset (dynamic bodies remove)
    const all = this.M.Composite.allBodies(this.world);
    for(const b of all){
      if(!b.isStatic) this.M.Composite.remove(this.world, b);
    }
    this._bodies = [];
    this._rocks.clear();
    this._mergingPairs.clear();
    this.score = 0;
    this.level = 1;
    this.dead = false;
    this.canDrop = true;
    this._comboCount = 0;
    this._lastMergeAt = 0;
    if(this._comboFinalizeTimer){ clearTimeout(this._comboFinalizeTimer); this._comboFinalizeTimer=null; }

    this.currentShapeIndex = 0;
    this.nextShapeIndex = this._randShapeIndex();
    this._generateNextShape();
    this._generateNextShape();
  }

  tick(dt){
    if(this.dead) return;
    // clamp dt to keep physics stable
    const step = clamp(dt, 8, 33);
    this.M.Engine.update(this.engine, step);

    // update landed flags
    for(const s of this._bodies){
      if(s.hasLanded) continue;
      // very simple: if speed low and y is below danger line, mark landed
      const v = s.body.velocity;
      if(Math.abs(v.y) < 0.25 && Math.abs(v.x) < 0.25){
        s.hasLanded = true;
      }
    }

    // game over check: landed body crosses danger line
    for(const s of this._bodies){
      if(!s.hasLanded) continue;
      if(s.body.position.y < this._dangerY){
        this.dead = true;
        break;
      }
    }
  }

  setDropXByCanvasX(clientX, rect){
    // rect: canvas.getBoundingClientRect()
    const x = (clientX - rect.left);
    this.dropX = clamp(x, 22, this.width-22);
  }

  nudge(dx){
    this.dropX = clamp(this.dropX + dx, 22, this.width-22);
  }

  drop(){
    if(this.dead || !this.canDrop) return false;
    this.canDrop = false;
    const idx = this.currentShapeIndex;
    const body = this._createBody(this.dropX, this._dangerY + 6, idx, false);
    this._bodies.push({ body, shapeIndex: idx, id: body.id, hasLanded: false, isRock: false });
    this.M.Composite.add(this.world, body);

    // next
    this._generateNextShape();
    // drop cooldown (짧게)
    setTimeout(()=>{ this.canDrop = !this.dead; }, 220);
    return true;
  }

  applyRocks(n){
    if(this.dead) return;
    const count = Math.max(0, n|0);
    for(let i=0;i<count;i++){
      const x = randInt(this.rng, 18, Math.max(18, this.width-18));
      const y = 18;
      const body = this._createRock(x, y);
      this._bodies.push({ body, shapeIndex: -1, id: body.id, hasLanded: false, isRock: true });
      this._rocks.add(body.id);
      this.M.Composite.add(this.world, body);
    }
  }

  packState(){
    // 상대 렌더용 최소 상태(정규화)
    const objs = [];
    for(const s of this._bodies){
      const p = s.body.position;
      objs.push({
        x: p.x / this.width,
        y: p.y / this.height,
        a: s.body.angle,
        i: s.isRock ? -1 : s.shapeIndex,
        r: s.isRock ? 1 : 0,
      });
    }
    return {
      objects: objs,
      score: this.score,
      level: this.level,
      dead: !!this.dead,
    };
  }

  setOppState(state){
    // no-op: 상대는 main에서 drawOpponent로 그립니다.
  }

  draw(){
    const ctx = this.ctx;
    const w = this.width, h = this.height;
    ctx.clearRect(0,0,w,h);

    // background subtle
    ctx.fillStyle = "#f6f1e6";
    ctx.fillRect(0,0,w,h);

    // danger line
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, this._dangerY);
    ctx.lineTo(w, this._dangerY);
    ctx.stroke();

    // bodies
    for(const s of this._bodies){
      this._drawBody(ctx, s);
    }

    // drop preview
    if(!this.dead){
      this._drawPreview(ctx);
    }
  }

  drawNext(ctx){
    const w = ctx.canvas.width, h = ctx.canvas.height;
    ctx.clearRect(0,0,w,h);
    ctx.fillStyle = "rgba(15,23,42,0.35)";
    ctx.fillRect(0,0,w,h);

    const idx = this.nextShapeIndex;
    const shape = SHAPES[idx];
    const size = shape.size;
    const cx = w/2, cy = h/2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = shape.color;
    ctx.strokeStyle = "rgba(255,255,255,0.65)";
    ctx.lineWidth = 2;
    this._pathForShape(ctx, shape, size);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // ---------------- internal ----------------

  _setupBounds(){
    // 곡선 바닥/벽: CSS 컵(50%/40%) 비율과 맞추기
    const wallOpts = { isStatic: true, friction: 0.8, restitution: 0.1, label: "wall" };

    const w = this.width;
    const h = this.height;

    const inset = 8;
    const centerX = w / 2;
    const radiusX = w / 2 - inset;
    const curveTopY = h * 0.6;
    const bottomY = h;
    const radiusY = bottomY - curveTopY;

    const floorT = 14;
    const segments = 28;
    for(let i=0;i<segments;i++){
      const a1 = Math.PI - (i/segments)*Math.PI;
      const a2 = Math.PI - ((i+1)/segments)*Math.PI;

      const x1 = centerX + radiusX * Math.cos(a1);
      const y1 = curveTopY + radiusY * Math.sin(a1);
      const x2 = centerX + radiusX * Math.cos(a2);
      const y2 = curveTopY + radiusY * Math.sin(a2);

      const midX = (x1 + x2) / 2;
      const midY = (y1 + y2) / 2;
      const dx = x2 - x1;
      const dy = y2 - y1;

      const segLen = Math.hypot(dx, dy) + 4;
      const ang = Math.atan2(dy, dx);

      const invLen = 1 / (Math.hypot(dx, dy) || 1);
      const tx = dx * invLen;
      const ty = dy * invLen;

      let nx = -ty, ny = tx;
      const vx = midX - centerX;
      const vy = midY - curveTopY;
      if(nx*vx + ny*vy < 0){ nx = -nx; ny = -ny; }

      const offX = midX + nx * (floorT/2);
      const offY = midY + ny * (floorT/2);

      const seg = this.M.Bodies.rectangle(offX, offY, segLen, floorT, { ...wallOpts, angle: ang, label:"floor" });
      this.M.Composite.add(this.world, seg);
    }

    // side walls (inner faces at x=0/w)
    const wallT = 24;
    this.M.Composite.add(this.world, this.M.Bodies.rectangle(-wallT/2, curveTopY/2, wallT, curveTopY + wallT, wallOpts));
    this.M.Composite.add(this.world, this.M.Bodies.rectangle(w + wallT/2, curveTopY/2, wallT, curveTopY + wallT, wallOpts));
  }

  _randShapeIndex(){
    // 첫 단계는 자주 나오도록 (원본 느낌)
    const r = this.rng();
    if(r < 0.55) return 0;
    if(r < 0.80) return 1;
    if(r < 0.92) return 2;
    return randInt(this.rng, 0, Math.min(4, SHAPES.length-1));
  }

  _generateNextShape(){
    this.currentShapeIndex = this.nextShapeIndex;
    this.nextShapeIndex = this._randShapeIndex();
    // update level: highest shape index in field (+1)
    let hi = 0;
    for(const s of this._bodies){
      if(!s.isRock) hi = Math.max(hi, s.shapeIndex);
    }
    this.level = hi + 1;
  }

  _createBody(x, y, shapeIndex, isRock){
    const shape = SHAPES[shapeIndex];
    const size = shape.size;
    const opts = {
      friction: 0.25,
      frictionAir: 0.01,
      restitution: 0.15,
      density: 0.0022,
      label: "shape",
    };

    let body = null;
    if(shape.type === "circle"){
      body = this.M.Bodies.circle(x, y, size, opts);
    }else if(shape.type === "triangle"){
      body = this.M.Bodies.polygon(x, y, 3, size, opts);
    }else if(shape.type === "isoceles"){
      // slim triangle
      body = this.M.Bodies.polygon(x, y, 3, size, opts);
      this.M.Body.scale(body, 1.15, 0.85);
    }else if(shape.type === "square"){
      body = this.M.Bodies.rectangle(x, y, size*1.55, size*1.55, opts);
    }else if(shape.type === "rectangle"){
      body = this.M.Bodies.rectangle(x, y, size*2.0, size*1.35, opts);
    }else if(shape.type === "pentagon"){
      body = this.M.Bodies.polygon(x, y, 5, size, opts);
    }else if(shape.type === "hexagon"){
      body = this.M.Bodies.polygon(x, y, 6, size, opts);
    }else if(shape.type === "octagon"){
      body = this.M.Bodies.polygon(x, y, 8, size, opts);
    }else{
      body = this.M.Bodies.circle(x, y, size, opts);
    }

    body.plugin = body.plugin || {};
    body.plugin.shapeIndex = shapeIndex;
    body.plugin.isRock = !!isRock;
    return body;
  }

  _createRock(x, y){
    const size = SHAPES[0].size; // "1단계 원 크기"
    const opts = {
      friction: 0.55,
      frictionAir: 0.015,
      restitution: 0.05,
      density: 0.003,
      label: "rock",
    };
    // 각이 진 짱돌: 6~8각 랜덤 다각형
    const sides = randInt(this.rng, 6, 8);
    const body = this.M.Bodies.polygon(x, y, sides, size, opts);
    // 약간 찌그러뜨려 각진 느낌
    this.M.Body.scale(body, 1.15, 0.90);
    body.plugin = body.plugin || {};
    body.plugin.shapeIndex = -1;
    body.plugin.isRock = true;
    return body;
  }

  _handleCollision(a, b){
    if(this.dead) return;
    const la=a.label, lb=b.label;

    // floor landing sound/flag: just mark landed
    if(la==="floor" || lb==="floor"){
      const shape = (la==="floor")? b : a;
      const sdata = this._bodies.find(s=>s.body.id===shape.id);
      if(sdata && !sdata.hasLanded) sdata.hasLanded = true;
      return;
    }
    if(a.isStatic || b.isStatic) return;

    // ignore rocks for merging
    const sa = this._bodies.find(s=>s.body.id===a.id);
    const sb = this._bodies.find(s=>s.body.id===b.id);
    if(!sa || !sb) return;
    if(sa.isRock || sb.isRock) return;

    if(sa.shapeIndex !== sb.shapeIndex) return;
    if(sa.shapeIndex >= SHAPES.length-1) return;

    const pairKey = [a.id,b.id].sort().join("-");
    if(this._mergingPairs.has(pairKey)) return;
    this._mergingPairs.add(pairKey);
    setTimeout(()=>this._mergingPairs.delete(pairKey), 120);

    // combo tracking
    const now = Date.now();
    if(now - this._lastMergeAt < 600) this._comboCount++;
    else this._comboCount = 1;
    this._lastMergeAt = now;

    // finalize timer: chain end => attack if >=3
    if(this._comboFinalizeTimer) clearTimeout(this._comboFinalizeTimer);
    this._comboFinalizeTimer = setTimeout(()=>{
      const n = this._comboCount|0;
      if(n >= 3 && typeof this.onAttack === "function"){
        try{ this.onAttack(n); }catch{}
      }
      this._comboCount = 0;
      this._comboFinalizeTimer = null;
    }, 650);

    const newIndex = sa.shapeIndex + 1;
    const mx = (a.position.x + b.position.x)/2;
    const my = (a.position.y + b.position.y)/2;
    this.lastMergePos = {x: mx, y: my};

    // remove old bodies
    this.M.Composite.remove(this.world, a);
    this.M.Composite.remove(this.world, b);
    this._bodies = this._bodies.filter(s=>s.body.id!==a.id && s.body.id!==b.id);

    // create new merged body
    const nb = this._createBody(mx, my, newIndex, false);
    this._bodies.push({ body: nb, shapeIndex: newIndex, id: nb.id, hasLanded: true, isRock: false });
    this.M.Composite.add(this.world, nb);

    // score (원본 방식 가볍게)
    const pts = (newIndex+1) * 10 * Math.max(1, this._comboCount||1);
    this.score += pts;

    // rocks vanish if near merge
    this._removeNearbyRocks(mx, my);
  }

  _removeNearbyRocks(x,y){
    const r = SHAPES[0].size * 3.2; // "근처" 반경
    const r2 = r*r;
    const toRemove = [];
    for(const s of this._bodies){
      if(!s.isRock) continue;
      const p = s.body.position;
      if(dist2(p.x,p.y,x,y) <= r2){
        toRemove.push(s);
      }
    }
    if(!toRemove.length) return;
    for(const s of toRemove){
      this.M.Composite.remove(this.world, s.body);
      this._rocks.delete(s.body.id);
    }
    this._bodies = this._bodies.filter(s=>!toRemove.includes(s));
  }

  _drawPreview(ctx){
    const idx = this.currentShapeIndex;
    const shape = SHAPES[idx];
    const size = shape.size;
    ctx.save();
    ctx.globalAlpha = this.canDrop ? 0.35 : 0.15;
    ctx.translate(this.dropX, this._dangerY + 6);
    ctx.fillStyle = shape.color;
    ctx.strokeStyle = "rgba(255,255,255,0.65)";
    ctx.lineWidth = 2;
    this._pathForShape(ctx, shape, size);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  _drawBody(ctx, s){
    const b = s.body;
    const p = b.position;

    if(s.isRock){
      ctx.fillStyle = "#64748b";
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 2;
      drawPolyWorld(ctx, b.vertices);
      ctx.fill();
      ctx.stroke();

      // face (world coords)
      ctx.fillStyle = "rgba(15,23,42,0.85)";
      const s0 = SHAPES[0].size;
      ctx.font = `${Math.max(10, Math.floor(s0*0.9))}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("x_x", p.x, p.y);
      return;
    }

    const idx = s.shapeIndex;
    const shape = SHAPES[idx];
    ctx.fillStyle = shape.color;
    ctx.strokeStyle = "rgba(255,255,255,0.65)";
    ctx.lineWidth = 2;

    // circles have circleRadius
    if(typeof b.circleRadius === "number" && b.circleRadius > 0){
      ctx.beginPath();
      ctx.arc(p.x, p.y, b.circleRadius, 0, Math.PI*2);
      ctx.fill();
      ctx.stroke();
      return;
    }

    drawPolyWorld(ctx, b.vertices);
    ctx.fill();
    ctx.stroke();
  }

  _pathForShape(ctx, shape, size){
    // Create shape path around origin (0,0)
    ctx.beginPath();
    if(shape.type === "circle"){
      ctx.arc(0,0,size,0,Math.PI*2);
    } else if(shape.type === "triangle" || shape.type === "isoceles"){
      const r=size;
      for(let i=0;i<3;i++){
        const a = -Math.PI/2 + i*(2*Math.PI/3);
        const x = r*Math.cos(a);
        const y = r*Math.sin(a);
        if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
      }
      ctx.closePath();
    } else if(shape.type === "square"){
      const w=size*1.55, h=size*1.55;
      ctx.rect(-w/2,-h/2,w,h);
    } else if(shape.type === "rectangle"){
      const w=size*2.0, h=size*1.35;
      ctx.rect(-w/2,-h/2,w,h);
    } else if(shape.type === "pentagon"){
      const r=size;
      for(let i=0;i<5;i++){
        const a = -Math.PI/2 + i*(2*Math.PI/5);
        const x = r*Math.cos(a), y=r*Math.sin(a);
        if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
      }
      ctx.closePath();
    } else if(shape.type === "hexagon"){
      const r=size;
      for(let i=0;i<6;i++){
        const a = -Math.PI/2 + i*(2*Math.PI/6);
        const x = r*Math.cos(a), y=r*Math.sin(a);
        if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
      }
      ctx.closePath();
    } else if(shape.type === "octagon"){
      const r=size;
      for(let i=0;i<8;i++){
        const a = -Math.PI/2 + i*(2*Math.PI/8);
        const x = r*Math.cos(a), y=r*Math.sin(a);
        if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
      }
      ctx.closePath();
    } else {
      ctx.arc(0,0,size,0,Math.PI*2);
    }
  }
}

// Because drawing body vertices in local coords is tricky without re-computation,
// drawOpponent uses world coords directly and avoids transforms.
function drawPolyWorld(ctx, verts){
  if(!verts || verts.length<2) return;
  ctx.beginPath();
  ctx.moveTo(verts[0].x, verts[0].y);
  for(let i=1;i<verts.length;i++) ctx.lineTo(verts[i].x, verts[i].y);
  ctx.closePath();
}

export function drawOpponent(ctx, objects){
  const w = ctx.canvas.width, h = ctx.canvas.height;
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle = "#f6f1e6";
  ctx.fillRect(0,0,w,h);
  if(!objects || !objects.length) return;

  // lightweight render: circles/polys based on index only (approx)
  for(const o of objects){
    const x = o.x * w;
    const y = o.y * h;
    const a = o.a || 0;
    const isRock = (o.r|0) === 1 || (o.i|0) === -1;
    ctx.save();
    ctx.translate(x,y);
    ctx.rotate(a);

    if(isRock){
      const s0 = SHAPES[0].size * (w/120); // scale
      ctx.fillStyle = "#64748b";
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 1.5;
      // draw octagon-ish
      ctx.beginPath();
      const r = s0*0.95;
      for(let i=0;i<8;i++){
        const ang = -Math.PI/2 + i*(2*Math.PI/8);
        const px = r*Math.cos(ang), py=r*Math.sin(ang);
        if(i===0) ctx.moveTo(px,py); else ctx.lineTo(px,py);
      }
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = "rgba(15,23,42,0.85)";
      ctx.font = `${Math.max(8, Math.floor(r*0.75))}px system-ui, sans-serif`;
      ctx.textAlign="center"; ctx.textBaseline="middle";
      ctx.fillText("x_x", 0, 0);
      ctx.restore();
      continue;
    }

    const idx = clamp(o.i|0, 0, SHAPES.length-1);
    const shape = SHAPES[idx];
    const base = shape.size * (w/120);
    ctx.fillStyle = shape.color;
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = 1.5;
    // approx path
    ctx.beginPath();
    if(shape.type==="circle"){
      ctx.arc(0,0,base,0,Math.PI*2);
    }else{
      let sides = 6;
      if(shape.type==="triangle"||shape.type==="isoceles") sides=3;
      else if(shape.type==="pentagon") sides=5;
      else if(shape.type==="hexagon") sides=6;
      else if(shape.type==="octagon") sides=8;
      else if(shape.type==="square") sides=4;
      if(shape.type==="rectangle"){
        ctx.rect(-base*1.2,-base*0.8, base*2.4, base*1.6);
      }else if(shape.type==="square"){
        ctx.rect(-base,-base, base*2, base*2);
      }else{
        for(let i=0;i<sides;i++){
          const ang=-Math.PI/2 + i*(2*Math.PI/sides);
          const px=base*Math.cos(ang), py=base*Math.sin(ang);
          if(i===0) ctx.moveTo(px,py); else ctx.lineTo(px,py);
        }
        ctx.closePath();
      }
    }
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }
}
