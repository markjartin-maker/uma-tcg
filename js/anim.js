// Play animations: preset effects (drawn on a canvas), custom-code effects
// (run in a sealed-off frame), and the clash intro at the start of a match.
window.Anim = (() => {
  const { h } = U;

  // ---------- library (saved animations, shared by the group) ----------
  // row: { id, owner, name, kind: 'preset' | 'code', config: {...}, code, duration }
  let lib = [];
  const setLibrary = rows => { lib = rows || []; };
  const list = () => lib.slice();
  const get = id => lib.find(a => a.id === id) || null;

  const PRESETS = [
    { id: 'lightning', label: 'Lightning strike' },
    { id: 'flame', label: 'Flame burst' },
    { id: 'shockwave', label: 'Shockwave' },
    { id: 'petals', label: 'Petal shower' },
    { id: 'sparkles', label: 'Sparkle rain' },
    { id: 'rays', label: 'Light rays + card' },
    { id: 'speed', label: 'Speed lines' },
    { id: 'slam', label: 'Card slam' },
    { id: 'shake', label: 'Screen shake' },
  ];
  const PRESET_DEFAULT = { effect: 'lightning', colorMode: 'card', c1: '#4fb0ff', c2: '#ffd66b', intensity: 2, banner: '' };

  const CODE_TEMPLATE = `<!-- Your animation. It plays over the table for its duration.
     PLAY has: PLAY.name, PLAY.colors (two colors), PLAY.art (image URL or null),
     PLAY.player (who played it), PLAY.mine (true if the viewer played it), PLAY.duration (seconds).
     It can draw anything, but can't reach the game, the page or anyone's login. -->
<style>
  .burst { position: fixed; left: 50%; top: 50%; width: 30px; height: 30px; border-radius: 50%;
    transform: translate(-50%, -50%); background: radial-gradient(circle, #fff, var(--c1) 40%, transparent 70%);
    animation: grow 1.4s ease-out forwards; }
  @keyframes grow { to { width: 180vmax; height: 180vmax; opacity: 0; } }
  .name { position: fixed; left: 0; right: 0; top: 40%; text-align: center; color: #fff;
    font: italic 900 72px system-ui, sans-serif; text-transform: uppercase; letter-spacing: 2px;
    text-shadow: 0 0 24px var(--c2), 0 4px 0 rgba(0,0,0,.5); animation: pop 2s ease-out forwards; }
  @keyframes pop { 0% { transform: scale(.4); opacity: 0 } 25% { transform: scale(1.08); opacity: 1 }
    80% { opacity: 1 } 100% { transform: scale(1); opacity: 0 } }
</style>
<div class="burst"></div>
<div class="name"></div>
<script>
  document.documentElement.style.setProperty('--c1', PLAY.colors[0]);
  document.documentElement.style.setProperty('--c2', PLAY.colors[1]);
  document.querySelector('.name').textContent = PLAY.name;
<\/script>
`;

  // ---------- viewer settings (this browser only) ----------
  function prefs() {
    try { return { on: true, code: true, ...JSON.parse(localStorage.getItem('uma-fx') || '{}') }; } catch (e) { return { on: true, code: true }; }
  }
  function setPrefs(p) { try { localStorage.setItem('uma-fx', JSON.stringify(p)); } catch (e) { /* private mode */ } }
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- helpers ----------
  const typeColor = t => getComputedStyle(document.documentElement).getPropertyValue('--t-' + t).trim() || '#f0b84a';
  function colorsOf(def) {
    const ts = def && def.types && def.types.length ? def.types : ['wit'];
    return [typeColor(ts[0]), typeColor(ts[1] || ts[0])];
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rnd = (a, b) => a + Math.random() * (b - a);
  function rgba(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return `rgba(255,255,255,${a})`;
    const n = parseInt(m[1], 16);
    return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
  }

  function makeCanvas(layer) {
    const cv = h('canvas', { class: 'anim-canvas' });
    layer.append(cv);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = window.innerWidth, H = window.innerHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    const g = cv.getContext('2d');
    g.scale(dpr, dpr);
    return { cv, g, W, H };
  }

  // Jagged lightning path from a to b (midpoint displacement).
  function boltPath(a, b, rough = 0.32, depth = 6) {
    let pts = [a, b];
    let amp = Math.hypot(b.x - a.x, b.y - a.y) * rough;
    for (let i = 0; i < depth; i++) {
      const next = [pts[0]];
      for (let j = 1; j < pts.length; j++) {
        const p = pts[j - 1], q = pts[j];
        const dx = q.x - p.x, dy = q.y - p.y, len = Math.hypot(dx, dy) || 1;
        const off = rnd(-amp, amp);
        next.push({ x: (p.x + q.x) / 2 - dy / len * off, y: (p.y + q.y) / 2 + dx / len * off }, q);
      }
      pts = next;
      amp /= 2;
    }
    return pts;
  }
  function strokePath(g, pts, style, width, alpha, blur, blurColor) {
    if (pts.length < 2) return;
    g.save();
    g.globalAlpha = alpha;
    g.strokeStyle = style;
    g.lineWidth = width;
    g.lineJoin = 'round'; g.lineCap = 'round';
    if (blur) { g.shadowBlur = blur; g.shadowColor = blurColor || '#fff'; }
    g.beginPath();
    g.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
    g.stroke();
    g.restore();
  }
  // Glow is built from wide translucent strokes (cheap), not shadowBlur.
  function drawBolt(g, pts, style, glowColor, k = 1) {
    strokePath(g, pts, style, 26 * k, 0.08);
    strokePath(g, pts, style, 14 * k, 0.18);
    strokePath(g, pts, style, 6 * k, 0.8);
    strokePath(g, pts, '#ffffff', 2 * k, 0.95);
  }

  // Simple particle system.
  function particles() {
    const ps = [];
    return {
      add: p => ps.push({ life: 0, rot: 0, vr: 0, g: 0, drag: 1, shape: 'dot', ...p }),
      step(dt, g, now) {
        for (let i = ps.length - 1; i >= 0; i--) {
          const p = ps[i];
          p.life += dt;
          if (p.life > p.max) { ps.splice(i, 1); continue; }
          p.vy += p.g * dt; p.vx *= p.drag; p.vy *= p.drag;
          p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
          const a = 1 - p.life / p.max;
          g.save();
          g.globalAlpha = Math.max(0, a * (p.alpha ?? 1));
          g.translate(p.x, p.y); g.rotate(p.rot);
          g.fillStyle = p.color; g.strokeStyle = p.color;
          if (p.shape === 'dot') { if (!p.flat) { g.shadowBlur = 10; g.shadowColor = p.color; } g.beginPath(); g.arc(0, 0, p.size * (0.4 + 0.6 * a), 0, 7); g.fill(); }
          else if (p.shape === 'petal') { g.beginPath(); g.ellipse(0, 0, p.size, p.size * 0.45, 0, 0, 7); g.fill(); }
          else if (p.shape === 'star') {
            const tw = 0.6 + 0.4 * Math.sin(now / 90 + p.seed);
            if (!p.flat) { g.shadowBlur = 12; g.shadowColor = p.color; }
            g.beginPath();
            for (let k = 0; k < 8; k++) { const r = k % 2 ? p.size * 0.35 * tw : p.size * tw; g.lineTo(Math.cos(k * Math.PI / 4) * r, Math.sin(k * Math.PI / 4) * r); }
            g.closePath(); g.fill();
          } else if (p.shape === 'line') { g.lineWidth = p.size; g.lineCap = 'round'; if (!p.flat) { g.shadowBlur = 8; g.shadowColor = p.color; } g.beginPath(); g.moveTo(0, 0); g.lineTo(-p.len, 0); g.stroke(); }
          else if (p.shape === 'flame') {
            const r = p.size * (0.3 + 0.7 * a);
            const grd = g.createRadialGradient(0, 0, 0, 0, 0, r);
            grd.addColorStop(0, 'rgba(255,255,230,.9)'); grd.addColorStop(0.35, p.color); grd.addColorStop(1, 'rgba(0,0,0,0)');
            g.fillStyle = grd; g.beginPath(); g.arc(0, 0, r, 0, 7); g.fill();
          }
          g.restore();
        }
        return ps.length;
      },
      get count() { return ps.length; },
    };
  }

  // ---------- playing an animation ----------
  let current = null;
  function stop() {
    if (!current) return;
    current.stop();
    current = null;
  }

  // ctx: { def, player, mine }
  function play(anim, ctx = {}) {
    if (!anim) return false;
    const p = prefs();
    if (!p.on) return false;
    if (anim.kind === 'code' && !p.code) return false;
    stop();
    const cfg = { ...PRESET_DEFAULT, ...(anim.config || {}) };
    const colors = anim.kind !== 'code' && cfg.colorMode === 'custom' ? [cfg.c1, cfg.c2] : colorsOf(ctx.def);
    const dur = clamp(Number(anim.duration) || 2.5, 0.5, 6) * 1000;
    current = anim.kind === 'code' ? playCode(anim, ctx, colors, dur) : playPreset(cfg, ctx, colors, dur);
    // The animation's own sound (set in the Animation maker).
    const snd = (anim.config || {}).sound;
    if (snd && snd.url && window.Sound) Sound.playUrl(snd.url, snd.volume ?? 1, 'anim');
    return true;
  }

  function layerEl(cls = '') {
    const layer = h('div', { class: 'anim-layer ' + cls, 'aria-hidden': 'true' });
    document.body.append(layer);
    return layer;
  }

  function bannerEl(text, colors) {
    return text ? h('div', { class: 'anim-banner', style: { '--c1': colors[0], '--c2': colors[1] } }, text) : null;
  }

  function playPreset(cfg, ctx, colors, dur) {
    const layer = layerEl('preset fx-' + cfg.effect);
    layer.style.setProperty('--dur', dur + 'ms');
    const k = clamp(Number(cfg.intensity) || 2, 1, 3);
    const [c1, c2] = colors;
    const pal = [c1, c2, '#ffffff'];
    const { g, W, H } = makeCanvas(layer);
    const P = particles();
    const cx = W / 2, cy = H / 2;
    let shakeEl = null;
    // card for slam / rays
    if ((cfg.effect === 'slam' || cfg.effect === 'rays') && ctx.def) {
      if (cfg.effect === 'rays') layer.append(h('div', { class: 'anim-rays', style: { '--c1': c1, '--c2': c2 } }));
      layer.append(h('div', { class: 'anim-card ' + cfg.effect }, Cards.render(ctx.def, { size: 'l' })));
    }
    const ban = bannerEl(cfg.banner, colors);
    if (ban) layer.append(ban);
    if (cfg.effect === 'shake' || cfg.effect === 'slam') {
      shakeEl = document.getElementById('view');
      setTimeout(() => shakeEl && shakeEl.classList.add('anim-shake'), cfg.effect === 'slam' ? 330 : 0);
    }
    if (reduced()) {
      // calm version: a soft color flash and the banner
      layer.append(h('div', { class: 'anim-flash', style: { background: `radial-gradient(circle, ${rgba(c1, 0.45)}, transparent 70%)` } }));
    }

    const bolts = [];
    const rings = [];
    const t0 = performance.now();
    let last = t0, raf = 0, flash = 0;
    const strike = () => {
      const x = cx + rnd(-W * 0.18, W * 0.18);
      bolts.push({ pts: boltPath({ x, y: -20 }, { x: cx + rnd(-30, 30), y: cy + rnd(-20, 20) }, 0.28), born: performance.now(), color: Math.random() < 0.5 ? c1 : c2 });
      flash = 0.4;
      for (let i = 0; i < 18 * k; i++) {
        const a = rnd(0, Math.PI * 2), v = rnd(120, 520);
        P.add({ x: cx, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v, max: rnd(0.4, 0.9), size: rnd(2, 4), color: pal[i % 3], drag: 0.97, g: 200 });
      }
    };
    const ring = () => { rings.push({ born: performance.now() }); flash = Math.max(flash, 0.35); };
    const plan = {
      lightning: [0.04, 0.3, 0.55].slice(0, k).map(t => [t, strike]),
      shockwave: [0.02, 0.22, 0.42].slice(0, k).map(t => [t, ring]),
      slam: [[0.33, () => { ring(); for (let i = 0; i < 30 * k; i++) { const a = rnd(0, Math.PI * 2), v = rnd(200, 700); P.add({ x: cx, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v, max: rnd(0.4, 1), size: rnd(2, 5), color: pal[i % 3], drag: 0.96, g: 400 }); } }]],
      shake: [[0.01, () => { flash = 0.4; for (let i = 0; i < 24 * k; i++) { const a = rnd(0, Math.PI * 2), v = rnd(150, 600); P.add({ x: cx, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v, max: rnd(0.4, 0.9), size: rnd(2, 4), color: pal[i % 3], drag: 0.96, g: 300 }); } }]],
    }[cfg.effect] || [];
    const fired = new Set();

    function frame(now) {
      const rawDt = Math.max(0, (now - last) / 1000);
      const dt = Math.min(0.05, rawDt);
      last = now;
      const t = (now - t0) / dur;
      if (t >= 1) { end(); return; }
      g.clearRect(0, 0, W, H);
      plan.forEach(([at, fn], i) => { if (t >= at && !fired.has(i)) { fired.add(i); fn(); } });
      const emitting = t < 0.75;
      const rate = (n) => emitting && Math.random() < n * dt * k;
      // continuous emitters
      if (cfg.effect === 'flame') {
        for (let i = 0; i < 6 * k; i++) if (rate(9)) P.add({ shape: 'flame', x: rnd(0, W), y: H + 20, vx: rnd(-30, 30), vy: rnd(-520, -260), max: rnd(0.9, 1.6), size: rnd(30, 70), color: rgba(Math.random() < 0.5 ? c1 : c2, 0.8), drag: 0.99 });
        if (t < 0.25) for (let i = 0; i < 3 * k; i++) P.add({ shape: 'flame', x: cx + rnd(-40, 40), y: cy + rnd(-30, 30), vx: rnd(-260, 260), vy: rnd(-380, 60), max: rnd(0.5, 1), size: rnd(25, 55), color: rgba(c1, 0.8), drag: 0.97 });
      } else if (cfg.effect === 'petals') {
        for (let i = 0; i < 4 * k; i++) if (rate(7)) P.add({ shape: 'petal', x: rnd(0, W), y: -20, vx: rnd(-40, 80), vy: rnd(90, 200), max: rnd(2, 3.2), size: rnd(6, 11), color: pal[Math.floor(rnd(0, 3))], vr: rnd(-3, 3), alpha: 0.9 });
      } else if (cfg.effect === 'sparkles' || cfg.effect === 'rays') {
        for (let i = 0; i < 4 * k; i++) if (rate(cfg.effect === 'rays' ? 4 : 8)) P.add({ shape: 'star', x: rnd(0, W), y: rnd(-20, H * (cfg.effect === 'rays' ? 1 : 0.4)), vx: rnd(-10, 10), vy: rnd(30, 110), max: rnd(1, 2), size: rnd(5, 12), color: pal[Math.floor(rnd(0, 3))], seed: rnd(0, 9) });
      } else if (cfg.effect === 'speed') {
        for (let i = 0; i < 8 * k; i++) if (rate(14)) { const v = rnd(1800, 3200); P.add({ shape: 'line', x: -100, y: rnd(0, H), vx: v, vy: 0, max: rnd(0.35, 0.7), size: rnd(1.5, 4), len: rnd(120, 360), color: pal[Math.floor(rnd(0, 3))] }); }
      }
      // flash
      if (flash > 0.01) {
        g.fillStyle = `rgba(255,255,255,${flash})`;
        g.fillRect(0, 0, W, H);
        flash *= Math.pow(0.0005, rawDt); // real time, so slow computers don't keep the screen white
      }
      // shockwave rings
      for (const r of rings) {
        const a = (now - r.born) / 900;
        if (a > 1) continue;
        const rad = 30 + a * Math.max(W, H) * 0.75;
        g.save();
        g.globalAlpha = 1 - a;
        g.lineWidth = 18 * (1 - a) + 2;
        g.strokeStyle = a < 0.5 ? c1 : c2;
        g.shadowBlur = 30; g.shadowColor = c1;
        g.beginPath(); g.arc(cx, cy, rad, 0, 7); g.stroke();
        g.restore();
      }
      // lightning
      g.globalCompositeOperation = 'lighter';
      for (const b of bolts) {
        const a = (now - b.born) / 420;
        if (a > 1) continue;
        if (Math.random() < 0.35) b.pts = boltPath(b.pts[0], b.pts[b.pts.length - 1], 0.28);
        g.globalAlpha = 1 - a;
        drawBolt(g, b.pts, b.color, b.color, 1);
        g.globalAlpha = 1;
      }
      P.step(dt, g, now);
      g.globalCompositeOperation = 'source-over';
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    const fadeAt = setTimeout(() => layer.classList.add('out'), Math.max(0, dur - 450));
    function end() {
      cancelAnimationFrame(raf); clearTimeout(fadeAt);
      if (shakeEl) shakeEl.classList.remove('anim-shake');
      layer.remove();
      if (current && current.layer === layer) current = null;
    }
    const kill = setTimeout(end, dur + 100);
    return { layer, stop: () => { clearTimeout(kill); end(); } };
  }

  // Custom code runs in a sandboxed frame: scripts yes, but no access to
  // this page, its storage (logins) or the network.
  function playCode(anim, ctx, colors, dur) {
    const def = ctx.def || {};
    const art = def.image_url && /^(https:|data:)/.test(def.image_url) ? def.image_url : null;
    const PLAY = { name: def.name || 'Card', colors, art, player: ctx.player || '', mine: !!ctx.mine, duration: dur / 1000 };
    const json = JSON.stringify(PLAY).replace(/</g, '\\u003c');
    const doc = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; img-src https: data:; media-src https: data:">
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}</style>
<script>const PLAY = ${json};<\/script></head><body>${anim.code || ''}</body></html>`;
    const layer = layerEl('code');
    const frame = h('iframe', { class: 'anim-frame', sandbox: 'allow-scripts', title: 'Card animation', tabindex: '-1' });
    frame.setAttribute('allowtransparency', 'true');
    frame.srcdoc = doc;
    layer.append(frame);
    const fadeAt = setTimeout(() => layer.classList.add('out'), Math.max(0, dur - 350));
    const end = () => { clearTimeout(fadeAt); layer.remove(); if (current && current.layer === layer) current = null; };
    const kill = setTimeout(end, dur);
    return { layer, stop: () => { clearTimeout(kill); end(); } };
  }

  // ---------- clash intro (start of a match) ----------
  // me / them: { name, def (their Superhorse, may be null) }. Calls onDice when
  // it's time for the dice to drop in; the bolts fade out over them.
  function clash(meSide, themSide, onDice) {
    const cm = colorsOf(meSide.def), ct = colorsOf(themSide.def);
    const layer = layerEl('clash');
    const skip = () => finish(true);
    layer.style.pointerEvents = 'auto';
    layer.addEventListener('click', skip);
    const { g, W, H } = makeCanvas(layer);
    const side = (s, cls, col) => h('div', { class: 'clash-side ' + cls, style: { '--c1': col[0], '--c2': col[1] } },
      s.def ? Cards.render(s.def, { size: 'l' }) : h('div', { class: 'card card-back sz-l' }),
      h('span', { class: 'clash-name' }, s.name));
    layer.append(side(themSide, 'them', ct), side(meSide, 'me', cm), h('div', { class: 'clash-vs' }, 'VS'));

    const A = { x: -40, y: -40 }, B = { x: W + 40, y: H + 40 };
    const len = Math.hypot(B.x - A.x, B.y - A.y);
    const d = { x: (B.x - A.x) / len, y: (B.y - A.y) / len };
    const n = { x: -d.y, y: d.x }; // points toward the bottom-left half (yours)
    const at = (t, off) => ({ x: A.x + (B.x - A.x) * t + n.x * off, y: A.y + (B.y - A.y) * t + n.y * off });
    const gap = t => 8 + 46 * Math.abs(t - 0.5) * 2;
    // a bolt along the seam, offset to one side; regenerated for the crackle
    const makeBolt = sign => {
      const pts = [];
      const steps = 34;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const jag = i === 0 || i === steps ? 0 : rnd(-22, 22) * (0.5 + Math.abs(t - 0.5));
        pts.push({ ...at(t, sign * gap(t) + jag), t });
      }
      // fine detail between the kinks
      const out = [pts[0]];
      for (let i = 1; i < pts.length; i++) {
        const sub = boltPath(pts[i - 1], pts[i], 0.25, 2).slice(1);
        sub.forEach((q, j) => out.push({ x: q.x, y: q.y, t: pts[i - 1].t + (pts[i].t - pts[i - 1].t) * (j + 1) / sub.length }));
      }
      return out;
    };
    const gradFor = col => { const gr = g.createLinearGradient(A.x, A.y, B.x, B.y); gr.addColorStop(0, col[0]); gr.addColorStop(1, col[1]); return gr; };
    const gm = gradFor(cm), gt = gradFor(ct);
    let boltMe = makeBolt(1), boltThem = makeBolt(-1);
    const P = particles();
    const quick = reduced();
    // Leaders arrive, bolts strike (~0.7s), clash and crackle (~2.8s), then the dice drop in.
    const T_STRIKE = quick ? 0 : 700, T_MEET = quick ? 0 : 1250, T_DICE = quick ? 1600 : 4000, T_END = quick ? 2200 : 4700;
    const t0 = performance.now();
    let last = t0, raf = 0, diced = false, done = false, flash = 0;

    function draw(now) {
      const el = now - t0;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (el >= T_DICE && !diced) { diced = true; layer.classList.add('out'); if (onDice) onDice(); }
      if (el >= T_END) { finish(false); return; }
      g.clearRect(0, 0, W, H);
      // strike: both bolts grow from the two corners toward the middle
      const p = clamp((el - T_STRIKE) / (T_MEET - T_STRIKE || 1), 0, 1);
      if (el >= T_STRIKE) {
        if (!quick && Math.random() < 0.5) { boltMe = makeBolt(1); boltThem = makeBolt(-1); }
        const part = pts => p >= 1 ? [pts] : [pts.filter(q => q.t <= p * 0.5), pts.filter(q => q.t >= 1 - p * 0.5)];
        g.globalCompositeOperation = 'lighter';
        for (const seg of part(boltMe)) drawBolt(g, seg, gm, cm[0], 1.1);
        for (const seg of part(boltThem)) drawBolt(g, seg, gt, ct[0], 1.1);
        if (p >= 1) {
          // the clash point: both players' colors blend into a white-hot core
          const pulse = 0.75 + 0.25 * Math.sin(now / 45);
          const r = Math.min(W, H) * 0.16 * pulse;
          const grd = g.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, r);
          grd.addColorStop(0, 'rgba(255,255,255,.95)');
          grd.addColorStop(0.25, rgba(cm[0], 0.7));
          grd.addColorStop(0.55, rgba(ct[1], 0.45));
          grd.addColorStop(1, 'rgba(0,0,0,0)');
          g.fillStyle = grd; g.fillRect(0, 0, W, H);
          // sparks fly into each player's half
          if (!diced) for (let i = 0; i < 5; i++) {
            const mine = Math.random() < 0.5;
            const col = mine ? cm : ct;
            const t = rnd(0.12, 0.88);
            const o = at(t, (mine ? 1 : -1) * gap(t));
            const sgn = mine ? 1 : -1;
            const v = rnd(120, 420);
            P.add({ x: o.x, y: o.y, vx: n.x * sgn * v + d.x * rnd(-120, 120), vy: n.y * sgn * v + d.y * rnd(-120, 120), max: rnd(0.4, 0.9), size: rnd(1.8, 3.6), color: col[Math.random() < 0.5 ? 0 : 1], drag: 0.97 });
          }
        }
        P.step(dt, g, now);
        g.globalCompositeOperation = 'source-over';
      }
      // a quick white flash the moment the bolts meet
      flash = el >= T_MEET && !quick ? Math.max(0, 0.55 * (1 - (el - T_MEET) / 320)) : 0;
      if (flash > 0.01) { g.fillStyle = `rgba(255,255,255,${flash})`; g.fillRect(0, 0, W, H); }
      raf = requestAnimationFrame(draw);
    }
    raf = requestAnimationFrame(draw);
    function finish(skipped) {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      if (!diced && onDice) onDice();
      if (skipped) { layer.classList.add('out'); setTimeout(() => layer.remove(), 300); } else layer.remove();
    }
  }

  // ---------- clash intro for 3–4 players ----------
  // sides[0] is the viewer (bottom-left); the others take the other corners.
  // Every player's bolt strikes from their corner into the middle.
  function clashAll(sides, onDice) {
    const layer = layerEl('clash multi');
    layer.style.pointerEvents = 'auto';
    const { g, W, H } = makeCanvas(layer);
    const CORNERS = [
      { cls: 'me', x: -30, y: H + 30 },        // bottom-left (you)
      { cls: 'them', x: W + 30, y: -30 },      // top-right
      { cls: 'tl', x: -30, y: -30 },           // top-left
      { cls: 'br', x: W + 30, y: H + 30 },     // bottom-right
    ];
    const C = { x: W / 2, y: H / 2 };
    const ps = sides.slice(0, 4).map((sd, i) => {
      const col = colorsOf(sd.def);
      const corner = CORNERS[i];
      layer.append(h('div', { class: 'clash-side ' + corner.cls, style: { '--c1': col[0], '--c2': col[1] } },
        sd.def ? Cards.render(sd.def, { size: 'l' }) : h('div', { class: 'card card-back sz-l' }),
        h('span', { class: 'clash-name' }, sd.name)));
      const gr = g.createLinearGradient(corner.x, corner.y, C.x, C.y);
      gr.addColorStop(0, col[0]); gr.addColorStop(1, col[1]);
      const make = () => {
        const pts = boltPath(corner, { x: C.x + rnd(-8, 8), y: C.y + rnd(-8, 8) }, 0.18, 6);
        return pts.map((q, k) => ({ ...q, t: k / (pts.length - 1) }));
      };
      return { col, corner, gr, bolt: make(), make };
    });
    layer.append(h('div', { class: 'clash-vs' }, 'CLASH'));
    const P = particles();
    const quick = reduced();
    const T_STRIKE = quick ? 0 : 700, T_MEET = quick ? 0 : 1250, T_DICE = quick ? 1600 : 4000, T_END = quick ? 2200 : 4700;
    const t0 = performance.now();
    let last = t0, raf = 0, diced = false, done = false;
    layer.addEventListener('click', () => finish(true));
    function draw(now) {
      const el = now - t0;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (el >= T_DICE && !diced) { diced = true; layer.classList.add('out'); if (onDice) onDice(); }
      if (el >= T_END) { finish(false); return; }
      g.clearRect(0, 0, W, H);
      const p = clamp((el - T_STRIKE) / (T_MEET - T_STRIKE || 1), 0, 1);
      if (el >= T_STRIKE) {
        g.globalCompositeOperation = 'lighter';
        for (const pl of ps) {
          if (!quick && Math.random() < 0.5) pl.bolt = pl.make();
          drawBolt(g, p >= 1 ? pl.bolt : pl.bolt.filter(q => q.t <= p), pl.gr, pl.col[0], 1.1);
        }
        if (p >= 1) {
          const pulse = 0.75 + 0.25 * Math.sin(now / 45);
          const r = Math.min(W, H) * 0.18 * pulse;
          const grd = g.createRadialGradient(C.x, C.y, 0, C.x, C.y, r);
          grd.addColorStop(0, 'rgba(255,255,255,.95)');
          ps.forEach((pl, i) => grd.addColorStop(0.2 + 0.5 * (i + 1) / (ps.length + 1), rgba(pl.col[i % 2], 0.55)));
          grd.addColorStop(1, 'rgba(0,0,0,0)');
          g.fillStyle = grd; g.fillRect(0, 0, W, H);
          // sparks fly back toward each player's corner
          if (!diced) for (const pl of ps) {
            const dx = pl.corner.x - C.x, dy = pl.corner.y - C.y, len = Math.hypot(dx, dy) || 1;
            for (let k = 0; k < 2; k++) {
              const v = rnd(160, 460), a = rnd(-0.5, 0.5);
              const ux = dx / len, uy = dy / len;
              P.add({ x: C.x, y: C.y, vx: (ux * Math.cos(a) - uy * Math.sin(a)) * v, vy: (ux * Math.sin(a) + uy * Math.cos(a)) * v,
                max: rnd(0.5, 1), size: rnd(1.8, 3.6), color: pl.col[Math.random() < 0.5 ? 0 : 1], drag: 0.97 });
            }
          }
        }
        P.step(dt, g, now);
        g.globalCompositeOperation = 'source-over';
      }
      const flash = el >= T_MEET && !quick ? Math.max(0, 0.55 * (1 - (el - T_MEET) / 320)) : 0;
      if (flash > 0.01) { g.fillStyle = `rgba(255,255,255,${flash})`; g.fillRect(0, 0, W, H); }
      raf = requestAnimationFrame(draw);
    }
    raf = requestAnimationFrame(draw);
    function finish(skipped) {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      if (!diced && onDice) onDice();
      if (skipped) { layer.classList.add('out'); setTimeout(() => layer.remove(), 300); } else layer.remove();
    }
  }


  // ---------- victory ----------
  // The winner's Superhorse starts tiny in the middle, spirals and spins
  // as it grows, then explodes to full size with speed lines (its first
  // type's color above, its second type's color below).
  // opts: { def, name, mine, onDone }
  function victory(opts = {}) {
    const { def, name, mine, onDone, sleeve } = opts;
    const col = colorsOf(def);
    const layer = layerEl('victory');
    layer.style.pointerEvents = 'auto';
    layer.style.setProperty('--c1', col[0]);
    layer.style.setProperty('--c2', col[1]);
    const { g, W, H } = makeCanvas(layer);
    layer.append(h('div', { class: 'vic-wash' }));
    // The card is a thin 3D slab: front, back (the winner's sleeve) and four
    // edges, so you see its side go past as it flips.
    const flip = h('div', { class: 'vic-flip' },
      h('div', { class: 'vic-face front' }, def ? Cards.render(def, { size: 'l' }) : Cards.renderBack('l', '', sleeve)),
      h('div', { class: 'vic-face back' }, Cards.renderBack('l', '', sleeve)),
      h('div', { class: 'vic-edge l' }), h('div', { class: 'vic-edge r' }),
      h('div', { class: 'vic-edge t' }), h('div', { class: 'vic-edge b' }));
    const holder = h('div', { class: 'vic-card' }, flip);
    const title = h('div', { class: 'vic-title' },
      h('span', { class: 'vic-big' }, mine ? 'Victory!' : 'Victory'),
      h('span', { class: 'vic-name' }, `${name || 'Someone'} wins`));
    layer.append(holder, title);
    const C = { x: W / 2, y: H * 0.46 };
    const quick = reduced();
    const T_BOOM = quick ? 0 : 2400, T_FADE = quick ? 2000 : 5600, T_END = quick ? 2500 : 6200;
    const TURNS = 3;
    const R0 = Math.min(W, H) * 0.2;
    const P = particles();
    const rings = [];
    const t0 = performance.now();
    let last = t0, raf = 0, boomed = false, faded = false, done = false;
    const easeIn = t => t * t * t;
    const easeOutBack = t => { const c = 1.9; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
    layer.addEventListener('click', () => finish(true));
    // A speed line flying outward from the card's edge; upper half = color 1, lower = color 2.
    function streak(fromCenter = false) {
      const a = rnd(0, Math.PI * 2);
      const ux = Math.cos(a), uy = Math.sin(a);
      const start = fromCenter ? rnd(0, 30) : rnd(Math.min(W, H) * 0.18, Math.min(W, H) * 0.3);
      const v = rnd(900, 1900);
      P.add({ x: C.x + ux * start, y: C.y + uy * start, vx: ux * v, vy: uy * v, rot: a, shape: 'line',
        len: rnd(40, 160), size: rnd(1.5, 4.5), max: rnd(0.35, 0.8), color: uy < 0 ? col[0] : col[1], alpha: 0.95, flat: true });
    }
    function boom() {
      boomed = true;
      layer.classList.add('boom');
      for (let i = 0; i < 3; i++) rings.push({ t: -i * 0.12, color: i === 1 ? '#ffffff' : col[i ? 1 : 0] });
      for (let i = 0; i < (quick ? 0 : 100); i++) streak(true);
      for (let i = 0; i < (quick ? 0 : 60); i++) {
        const a = rnd(0, Math.PI * 2), v = rnd(200, 900);
        P.add({ x: C.x, y: C.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, shape: Math.random() < 0.25 ? 'star' : 'dot', seed: rnd(0, 9), flat: true,
          size: rnd(2, 6), max: rnd(0.8, 1.6), drag: 0.96, g: 120, color: Math.sin(a) < 0 ? col[0] : col[1] });
      }
    }
    function frame(now) {
      // (opts.seek holds the animation at one moment: for checking frames.)
      const el = opts.seek != null ? opts.seek : now - t0;
      const dt = opts.seek != null ? 1 / 60 : Math.min(0.05, (now - last) / 1000);
      last = now;
      if (el >= T_END) { finish(false); return; }
      if (el >= T_FADE && !faded) { faded = true; layer.classList.add('out'); }
      // The card: a spiral in toward the middle, spinning faster and growing.
      if (!boomed && !quick) {
        const p = clamp(el / T_BOOM, 0, 1);
        const e = easeIn(p);
        const r = R0 * Math.pow(1 - p, 1.3);
        const th = -Math.PI / 2 + p * Math.PI * 2 * 1.25;
        const x = Math.cos(th) * r, y = Math.sin(th) * r;
        const scale = 0.05 + 0.8 * e;
        // Flips upright around its vertical axis (front → side → back → side
        // → front), faster and faster, with a little lean.
        const rotY = 360 * TURNS * e;
        const lean = 16 * Math.sin(p * Math.PI);
        const tiltZ = -10 * Math.sin(p * Math.PI * 1.5);
        holder.style.transform = `translate(calc(-50% + ${x.toFixed(1)}px), calc(-50% + ${y.toFixed(1)}px)) scale(${scale.toFixed(3)}) rotate(${tiltZ.toFixed(1)}deg)`;
        flip.style.transform = `rotateX(${lean.toFixed(1)}deg) rotateY(${rotY.toFixed(1)}deg)`;
        // a glowing trail behind it
        if (Math.random() < 0.9) P.add({ x: C.x + x, y: C.y + y, vx: rnd(-30, 30), vy: rnd(-30, 30), shape: 'dot', size: 3 + 10 * e, max: 0.5, color: col[Math.random() < 0.5 ? 0 : 1], alpha: 0.8, flat: true });
      }
      if (el >= T_BOOM && !boomed) boom();
      if (boomed && !quick) {
        const k = clamp((el - T_BOOM) / 450, 0, 1);
        const scale = 0.85 + 0.15 * easeOutBack(k);
        holder.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(3)})`;
        // settles with a small wobble after the burst
        const wob = (1 - k) * 14 * Math.sin(k * Math.PI * 3);
        flip.style.transform = `rotateY(${wob.toFixed(1)}deg)`;
        if (!faded) for (let i = 0; i < 3; i++) streak(false);
      }
      g.clearRect(0, 0, W, H);
      g.globalCompositeOperation = 'lighter';
      for (let i = rings.length - 1; i >= 0; i--) {
        const rg = rings[i];
        rg.t += dt;
        if (rg.t < 0) continue;
        const q = rg.t / 0.9;
        if (q >= 1) { rings.splice(i, 1); continue; }
        const rad = Math.max(W, H) * 0.75 * (1 - Math.pow(1 - q, 3));
        g.save(); g.globalAlpha = 1 - q; g.strokeStyle = rg.color; g.lineWidth = 26 * (1 - q) + 2;
        g.beginPath(); g.arc(C.x, C.y, rad, 0, Math.PI * 2); g.stroke(); g.restore();
      }
      P.step(dt, g, now);
      // a soft halo behind the card while it builds up
      if (!quick) {
        const p = clamp(el / T_BOOM, 0, 1);
        const hr = Math.min(W, H) * (boomed ? 0.42 : 0.05 + 0.3 * easeIn(p));
        const halo = g.createRadialGradient(C.x, C.y, 0, C.x, C.y, hr);
        halo.addColorStop(0, `rgba(255,255,255,${boomed ? 0.25 : 0.35 * p})`); halo.addColorStop(0.5, rgba(col[0], 0.18)); halo.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = halo; g.fillRect(C.x - hr, C.y - hr, hr * 2, hr * 2);
      }
      g.globalCompositeOperation = 'source-over';
      const flash = boomed && !quick ? Math.max(0, 0.9 * (1 - (el - T_BOOM) / 380)) : 0;
      if (flash > 0.01) { g.fillStyle = `rgba(255,255,255,${flash})`; g.fillRect(0, 0, W, H); }
      raf = requestAnimationFrame(frame);
    }
    if (quick) { holder.style.transform = 'translate(-50%, -50%)'; boom(); }
    raf = requestAnimationFrame(frame);
    function finish(skipped) {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      if (skipped) { layer.classList.add('out'); setTimeout(() => layer.remove(), 400); } else layer.remove();
      if (onDone) onDone();
    }
    return { stop: () => finish(true) };
  }

  return { PRESETS, PRESET_DEFAULT, CODE_TEMPLATE, setLibrary, list, get, play, stop, prefs, setPrefs, colorsOf, clash, clashAll, victory };
})();
