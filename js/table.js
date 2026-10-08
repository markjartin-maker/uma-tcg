// The game table: draws the match and turns clicks into actions.
window.Table = (() => {
  const { h } = U;
  const G = () => window.CONFIG.GAME;

  let ui = null;

  async function open(el, matchId) {
    el.replaceChildren(h('p', { class: 'muted pad' }, 'Loading the table…'));
    let m;
    try { m = await App.backend.getMatch(matchId); } catch (e) { el.replaceChildren(h('p', { class: 'form-error pad' }, e.message)); return; }
    const seats = m.players && m.players.length > 2 ? m.players : [m.p1, m.p2];
    const isPlayer = seats.includes(App.me.id);
    // Matches started before tokens existed still get them.
    for (const t of Cards.TOKENS) if (!m.defs[t.id]) m.defs[t.id] = t;
    if (!m.state.ramp) m.state.ramp = 1;
    ui = {
      el, id: matchId, defs: m.defs, row: m, viewAs: isPlayer ? App.me.id : m.p1,
      winSeen: m.state.winner || null, // the victory animation plays once, when someone wins while you watch
      hotseat: App.backend.mode === 'demo', inspect: null, menu: null,
      pick: null, // {kind: 'target'|'attach', iid}
      seenPings: new Set((m.state.pings || []).map(p => p.n)),
      prevEx: new Map(Object.values(m.state.cards).map(c => [c.iid, c.exhausted])),
      pending: 0,              // actions sent but not yet confirmed by the server
      queue: Promise.resolve(), // keeps actions in order
      server: null,            // newest confirmed row while actions are pending
      longPress: null,
      seenChain: new Set((m.state.chain || []).map(x => x.n)),
      suppressClick: false,
      sel: new Set(), // multi-select
      seenRoll: (m.state.lastRoll || {}).n || 0,
      floatPos: (() => { try { const p = JSON.parse(localStorage.getItem('uma-float-pos')); return p && p.x < window.innerWidth - 40 && p.y < window.innerHeight - 40 ? p : null; } catch (e) { return null; } })(),
    };
    const unwatch = App.backend.watchMatch(matchId, row => {
      if (!ui || ui.id !== matchId) return;
      if (ui.pending) { if (!ui.server || row.version > ui.server.version) ui.server = row; return; }
      if (row.version <= ui.row.version) return;
      ui.row = row;
      draw();
    });
    const isTyping = t => t && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable);
    const onKey = e => {
      if (!ui) return;
      if (e.key === 'Escape') { closeMenu(); if (ui.pick) { ui.pick = null; draw(); } else clearSel(); return; }
      if ((e.code === 'Space' || e.key === ' ') && !isTyping(e.target) && !document.querySelector('.modal-backdrop')) {
        e.preventDefault();
        if (!e.repeat) passWithSpace();
      }
      if ((e.key === 's' || e.key === 'S') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat && !isTyping(e.target) && !document.querySelector('.modal-backdrop')) {
        const s = S();
        if (!s.chain || !s.chain.length) return;
        if (s.priority && s.priority !== me()) U.toast(`It's ${Game.nameOf(s, s.priority)}'s call.`);
        else act('resolve');
      }
    };
    // Stop Space from also "clicking" whatever button has focus.
    const onKeyUp = e => {
      if ((e.code === 'Space' || e.key === ' ') && !isTyping(e.target) && !document.querySelector('.modal-backdrop')) e.preventDefault();
    };
    const onResize = () => { placeHand(); drawArrows(); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('resize', onResize);
    // cleanup when leaving the screen
    const stop = () => {
      unwatch();
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('resize', onResize);
      closeMenu();
      hidePeek();
      ui = null;
    };
    Table._stop = stop;
    draw();
    // Fresh match: show the dice roll for who goes first.
    const s0 = S();
    if (s0.dice && s0.phase === 'mulligan' && !Object.keys(s0.mulligan || {}).length) {
      Sound.play('match_start');
      // The clash: both Superhorses face off, then the dice drop in as the bolts fade.
      const lead = pid => { const c = (s0.zones[pid + ':leader'] || []).map(i => s0.cards[i])[0]; return c ? def(c) : null; };
      const my = me(), op = Game.opp(s0, my);
      if (s0.order.length > 2) {
        // 3–4 players: everyone's bolt strikes from their corner into the middle.
        Anim.clashAll([my, ...rivalsOf(s0, my)].map(pid => ({ name: Game.nameOf(s0, pid), def: lead(pid) })), () => diceFx(s0, { drop: true }));
      } else {
        Anim.clash({ name: Game.nameOf(s0, my), def: lead(my) }, { name: Game.nameOf(s0, op), def: lead(op) }, () => diceFx(s0, { drop: true }));
      }
    }
  }

  const me = () => ui.viewAs;
  // Everyone else, in turn order starting after you.
  const rivalsOf = (s, pid) => { const i = s.order.indexOf(pid); return s.order.slice(i + 1).concat(s.order.slice(0, Math.max(0, i))).filter(p => p !== pid); };
  // A color per seat, so 3–4 player tables can tell cards apart.
  const SEAT_COLORS = ['#f0b84a', '#7fd8ff', '#ff7ac6', '#9be36b'];
  const seatColor = pid => SEAT_COLORS[Math.max(0, S().order.indexOf(pid)) % SEAT_COLORS.length];
  const S = () => ui.row.state;
  const def = c => ui.defs[c.def] || { name: 'Unknown card', card_type: 'uma', types: ['speed'] };
  const cap1 = t => String(t).charAt(0).toUpperCase() + String(t).slice(1);

  // Shows the result instantly, then saves it to the server in the background.
  // If the server disagrees (e.g. the other player acted at the same moment),
  // the table snaps to the server's version once everything is saved.
  function act(name, ...args) {
    if (!ui) return;
    const keep = ui.keepMenu;
    ui.keepMenu = false;
    if (!keep) closeMenu();
    const actor = me();
    const id = ui.id;
    const defs = ui.defs;
    let local;
    try {
      local = Game.apply(U.clone(ui.row.state), defs, actor, name, args);
    } catch (e) {
      U.toast(e.message, 'error');
      return;
    }
    ui.row = { ...ui.row, state: local };
    ui.pending++;
    draw();
    if (keep) refreshMenu();
    ui.queue = ui.queue.then(async () => {
      let row = null, failed = null;
      try {
        row = await App.backend.commitMatch(id, st => Game.apply(st, defs, actor, name, args));
      } catch (e) { failed = e; }
      if (!ui || ui.id !== id) return;
      ui.pending--;
      if (row && (!ui.server || row.version > ui.server.version)) ui.server = row;
      if (failed) { U.toast(failed.message, 'error'); ui.resync = true; }
      if (ui.pending) return;
      if (ui.resync && !ui.server) {
        try { const m = await App.backend.getMatch(id); ui.server = m; } catch (e) { /* keep local */ }
      }
      ui.resync = false;
      if (ui.server) {
        const same = U.stable(ui.server.state) === U.stable(ui.row.state);
        ui.row = ui.server;
        ui.server = null;
        if (!same) draw(); // only redraw if the server's table differs from what we showed
      }
    });
  }

  function passWithSpace() {
    const s = S();
    if (s.winner) return;
    if (s.phase === 'mulligan') { U.toast('Keep your hand or mulligan first (buttons at the top).'); return; }
    if (s.phase === 'ramp' && s.step < Game.CHECK(s)) {
      const t = Game.rampText(s);
      if (t.who === me()) act('nextStep');
      else U.toast(`It's ${Game.nameOf(s, t.who)}'s step. Use the Pass button to pass for them.`);
    } else {
      U.toast(s.phase === 'race' ? 'Use End Race (top right) when the Race is done.' : 'Choose Fight or Refuse (top right), then Continue.');
    }
  }

  // ---------- drawing ----------
  function draw() {
    if (!ui) return;
    hidePeek();
    ui.anims = [];
    const s = S();
    // Card code: cost and might changes in effect right now.
    try { ui.mods = Game.activeMods(s, ui.defs); } catch (e) { ui.mods = []; }
    // Chain items nobody has seen yet on this screen (for the Signature effect).
    const freshChain = (s.chain || []).filter(it => !ui.seenChain.has(it.n));
    const my = me();
    const op = Game.opp(s, my);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'arrows');
    svg.setAttribute('id', 'arrows');
    svg.setAttribute('aria-hidden', 'true');
    // 1v1: the opponent's side across the table. 3–4 players: a compact
    // panel per opponent, in turn order after you.
    const rivals = rivalsOf(s, my);
    const top = rivals.length > 1
      ? h('div', { class: 'opp-row n' + rivals.length }, rivals.map(pid => sideEl(pid, true, true)))
      : sideEl(op, true);
    const board = h('div', { class: 'board' + (s.phase === 'race' ? ' racing' : '') + (rivals.length > 1 ? ' multi' : ''), id: 'board' },
      top,
      lanesEl(),
      sideEl(my, false));
    const prevStars = new Map();
    for (const el of ui.el.querySelectorAll('.zone-pool .slot[data-iid]')) {
      const tok = el.querySelector('.star-token');
      if (tok) prevStars.set(el.dataset.iid, { rect: tok.getBoundingClientRect(), node: tok.cloneNode(true), ex: el.classList.contains('ex') });
    }
    const old = { x: (ui.el.querySelector('.board-scroll') || {}).scrollLeft || 0,
      side: (ui.el.querySelector('.sidebar') || {}).scrollTop || 0,
      log: (ui.el.querySelector('.log-list') || {}).scrollTop || 0 };
    board.addEventListener('contextmenu', e => e.preventDefault());
    const hud = hudEl();
    const scroller = h('div', { class: 'board-scroll' }, board, s.phase === 'mulligan' ? mulliganEl() : null, selBarEl(), floatEl(), pendingEl());
    bindBoxSelect(scroller);
    const side = sidebarEl();
    scroller.addEventListener('scroll', () => requestAnimationFrame(drawArrows), { passive: true });
    side.addEventListener('scroll', () => requestAnimationFrame(drawArrows), { passive: true });
    const wrap = h('div', { class: 'table' + (ui.pick ? ' picking' : '') + (s.phase === 'mulligan' ? ' mulligan' : '') },
      hud, scroller, side, svg);
    ui.el.replaceChildren(wrap);
    wrap.querySelector('.board-scroll').scrollLeft = old.x;
    wrap.querySelector('.sidebar').scrollTop = old.side;
    wrap.querySelector('.log-list').scrollTop = old.log;
    // Exhaust/ready animation: cards were drawn in their previous angle,
    // now flip them to the new one so the CSS transition plays.
    if (ui.anims.length) {
      const list = ui.anims;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        list.forEach(a => a.el.classList.toggle('ex', a.to));
        setTimeout(drawArrows, 340);
      }));
    }
    for (const c of Object.values(s.cards)) ui.prevEx.set(c.iid, Game.shownExhausted(c, my));
    animateStars(prevStars);
    // Turn bar: slide the marker from where it was to where it is now.
    const track = Game.phaseTrack(s);
    const trackEl = wrap.querySelector('.track');
    if (trackEl) {
      if (ui.lastPos !== undefined && ui.lastPos !== track.index) {
        requestAnimationFrame(() => requestAnimationFrame(() => trackEl.style.setProperty('--pos', track.index)));
      }
      ui.lastPos = track.index;
    }
    placeHand();
    const topbar = document.getElementById('topbar');
    if (topbar) document.documentElement.style.setProperty('--topbar-h', topbar.offsetHeight + 'px');
    document.documentElement.style.setProperty('--hud-h', hud.offsetHeight + 'px');
    // Flash on a real turn change, or when the chain hands *you* the call
    // (someone played something you can respond to).
    const chainTop = (s.chain || []).length ? s.chain[s.chain.length - 1].n : 0;
    const turnKey = `${s.round}-${s.ramp}-${s.step}-${s.phase}`;
    const callKey = chainTop && s.priority === me() ? `${chainTop}-${me()}` : '';
    for (const it of s.chain || []) ui.seenChain.add(it.n);
    if (s.lastRoll && s.lastRoll.n !== ui.seenRoll) { ui.seenRoll = s.lastRoll.n; rollFx(s, s.lastRoll); }
    const sdKey = s.showdown && s.showdown.active ? `${s.showdown.pid}-${s.showdown.made}` : '';
    if (sdKey && ui.sdKey !== undefined && ui.sdKey !== sdKey) showdownFx(s);
    ui.sdKey = sdKey;
    // Card play animations: a card's own animation (also when a face-down
    // card is revealed); Signature cards without one get the built-in moment.
    const played = freshChain.filter(it => it.kind !== 'ability' && s.cards[it.iid]).map(it => ({ c: s.cards[it.iid], by: it.by }));
    for (const c of Object.values(s.cards)) {
      if (ui.prevFD && ui.prevFD.has(c.iid) && !c.faceDown && Game.BOARD.includes(Game.zoneKind(c.zone))) played.push({ c, by: c.owner });
    }
    ui.prevFD = new Set(Object.values(s.cards).filter(c => c.faceDown && Game.BOARD.includes(Game.zoneKind(c.zone))).map(c => c.iid));
    const withAnim = played.filter(x => def(x.c).play_anim && Anim.get(def(x.c).play_anim)).pop();
    const sig = played.filter(x => Cards.isSignature(def(x.c))).pop();
    // Sounds: a card's animation sound, else the Signature sound, else "Card played".
    const animPlayed = !!withAnim && Anim.play(Anim.get(def(withAnim.c).play_anim), { def: def(withAnim.c), player: Game.nameOf(s, withAnim.by), mine: withAnim.by === me() });
    const animSound = animPlayed && ((Anim.get(def(withAnim.c).play_anim).config || {}).sound || {}).url;
    if (animPlayed) { if (!animSound) Sound.play('card_played'); }
    else if (sig) signatureFx(sig.c, sig.by);
    else if (played.length) Sound.play('card_played');
    ui.cardSoundAt = played.length ? Date.now() : ui.cardSoundAt;
    // The turn splash only when no card moment is showing.
    if (!animPlayed && !sig && !s.winner && ((ui.turnKey && ui.turnKey !== turnKey) || (callKey && ui.callKey !== callKey && ui.turnKey))) splash();
    ui.turnKey = turnKey;
    ui.callKey = callKey;
    const fightKey = s.fight && !s.fight.result && s.phase === 'ramp' ? turnKey : '';
    if (fightKey && ui.fightKey !== undefined && ui.fightKey !== fightKey) Sound.play('fight_check');
    ui.fightKey = fightKey;
    if (s.phase === 'race' && ui.lastPhase === 'ramp') Sound.play('race_start');
    ui.lastPhase = s.phase;
    if (ui.pick) {
      ui.el.prepend(h('div', { class: 'pick-banner', role: 'status' },
        ui.pick.kind === 'target' ? 'Click the card to point at.' : 'Click the card to attach to.',
        h('button', { class: 'btn ghost sm', on: { click: () => { ui.pick = null; draw(); } } }, 'Cancel (Esc)')));
    }
    if (s.winner) ui.el.append(winnerEl());
    if (s.winner && ui.winSeen !== s.winner) {
      ui.winSeen = s.winner;
      const lc = (s.zones[s.winner + ':leader'] || []).map(i => s.cards[i])[0];
      Anim.stop();
      Sound.play(s.winner === me() ? 'victory' : 'defeat');
      Anim.victory({ def: lc ? def(lc) : null, name: Game.nameOf(s, s.winner), mine: s.winner === me(), sleeve: sleeveOf(s.winner) });
    }
    requestAnimationFrame(drawArrows);
    // mark pings as seen after they've animated once
    for (const p of s.pings || []) ui.seenPings.add(p.n);
  }

  // Start of the match: look at your hand, keep it or mulligan it (once).
  function mulliganEl() {
    const s = S();
    const my = me();
    const op = Game.opp(s, my);
    const done = s.mulligan[my];
    const hand = (s.zones[my + ':hand'] || []).map(iid => s.cards[iid]);
    const n = hand.length;
    const rest = rivalsOf(s, my);
    const theirs = rest.every(pid => s.mulligan[pid]);
    // Your starting hand, dealt out big in the middle of the table.
    ui.mullSeen = ui.mullSeen || new Set();
    let k = 0;
    const cards = h('div', { class: 'mull-cards' }, hand.map(c => {
      const fresh = !ui.mullSeen.has(c.iid);
      ui.mullSeen.add(c.iid);
      const el = h('div', { class: 'mull-card' + (fresh ? ' deal' : ''), style: fresh ? { animationDelay: (k++ * 90) + 'ms' } : null,
        on: { mouseenter: e => showPeek(c, e.currentTarget), mouseleave: hidePeek } },
        Cards.render(def(c), { size: 'm' }));
      return el;
    }));
    return h('div', { class: 'mull-panel', role: 'dialog', 'aria-label': 'Mulligan' },
      h('p', { class: 'eyebrow' }, done === 'redraw' ? 'Your new hand' : 'Starting hand'),
      cards,
      done
        ? h('p', null, done === 'keep' ? 'You kept your hand.' : 'You drew a new hand.', ' ', theirs ? 'Starting…' : `Waiting for ${rest.filter(p => !s.mulligan[p]).map(p => Game.nameOf(s, p)).join(', ')}…`)
        : [h('p', null, `Look at your ${n} cards below. Keep them, or shuffle all of them back and draw ${n} new ones. You can only do this once.`),
          h('div', { class: 'row center' },
            h('button', { class: 'btn primary', on: { click: () => act('mulligan', 'keep') } }, 'Keep hand'),
            h('button', { class: 'btn', on: { click: () => act('mulligan', 'redraw') } }, `Mulligan (draw ${n} new)`))],
      h('p', { class: 'hint' }, rest.map(p => `${Game.nameOf(s, p)}: ${s.mulligan[p] ? 'decided' : 'deciding…'}`).join(' · ')));
  }

  // Card code: a triggered effect asks its owner first ("Do it" / "Skip").
  function pendingEl() {
    const s = S();
    const list = s.pending || [];
    if (!list.length || s.winner) return null;
    const mine = list.filter(p => p.owner === me() || (s.players[p.owner] && s.players[p.owner].out));
    if (mine.length) {
      const p = mine[0];
      const t = Game.pendingText(s, ui.defs, p);
      const d = ui.defs[p.def];
      const fresh = ui.lastAsk !== p.n;
      ui.lastAsk = p.n;
      if (fresh) Sound.play('effect_ask');
      return h('div', { class: 'effect-ask' + (fresh ? ' enter' : ''), role: 'dialog', 'aria-label': 'Card effect' },
        d ? h('div', { class: 'effect-card', on: { mouseenter: e => { const c = s.cards[p.iid]; if (c) showPeek(c, e.currentTarget); }, mouseleave: hidePeek } }, Cards.render(d, { size: 's' })) : null,
        h('div', { class: 'effect-body' },
          h('p', { class: 'eyebrow' }, `✦ ${t.name}${mine.length > 1 ? ` · ${mine.length - 1} more waiting` : ''}`),
          h('p', { class: 'effect-text' }, t.text),
          h('div', { class: 'row' },
            h('button', { class: 'btn primary', on: { click: () => act('resolveEffect', p.n) } }, 'Do it'),
            h('button', { class: 'btn ghost', on: { click: () => act('skipEffect', p.n) } }, 'Skip'))));
    }
    const p = list[0];
    const nm = p.hidden ? 'a card' : (ui.defs[p.def] || {}).name || 'a card';
    return h('div', { class: 'effect-wait', role: 'status' }, `✦ Waiting for ${Game.nameOf(s, p.owner)} to decide on ${nm}'s effect…`);
  }

  function winnerEl() {
    const s = S();
    const won = s.winner === me();
    return h('div', { class: 'winner-banner' },
      h('p', { class: 'eyebrow' }, won ? 'Victory' : 'Match over'),
      h('h2', null, `${Game.nameOf(s, s.winner)} wins`),
      h('p', null, `${s.order.map(p => `${Game.nameOf(s, p)}: ${s.players[p].fans} fans`).join(' · ')}`),
      h('div', { class: 'row' },
        s.undo && s.undo.by === me() ? h('button', { class: 'btn ghost', on: { click: () => act('undo') } }, 'Undo last action') : null,
        h('button', { class: 'btn primary', on: { click: () => { leave(); App.go('play'); } } }, 'Back to lobby')));
  }

  function leave() { if (Table._stop) Table._stop(); Table._stop = null; }

  function zoneCards(key) {
    const s = S();
    return (s.zones[key] || []).map(iid => s.cards[iid]);
  }

  function sideEl(pid, isOpp, compact = false) {
    const s = S();
    const p = s.players[pid];
    const key = z => `${pid}:${z}`;
    const deckN = (s.zones[key('deck')] || []).length;
    const starsN = (s.zones[key('stars')] || []).length;
    const trash = zoneCards(key('trash'));
    const banished = zoneCards(key('banish'));
    const hand = zoneCards(key('hand'));
    const mine = pid === me();

    const fans = h('div', { class: 'fans' + (mine ? ' mine' : '') },
      h('div', { class: 'fans-name' }, p.name, p.revealHand ? h('span', { class: 'pill' }, 'Hand revealed') : null),
      h('div', { class: 'fans-num' + (p.fans < 0 ? ' neg' : '') }, h('span', { class: 'n' }, p.fans), h('span', { class: 'of' }, 'fans')),
      h('div', { class: 'fans-btns' },
        [-10, -5, 5, 10, G().MINI_LANE_FANS, G().RACE_FANS].map(d => h('button', { class: 'chip-btn', on: { click: () => act('fans', pid, d) } }, (d > 0 ? '+' : '') + d))));

    const piles = h('div', { class: 'piles' },
      pileEl('Deck', deckN, mine ? { click: () => act('draw', 1), context: () => deckMenu(pid), title: 'Click: draw 1 · Right-click: shuffle or search' } : null, 'deck-top', pid),
      pileEl('Stars', starsN, mine ? { click: () => act('channel', 1), title: 'Click: channel 1 Star' } : null, null, pid),
      pileEl('Trash', trash.length, { click: () => trashModal(pid), context: () => trashModal(pid), title: 'Click: look at the trash' }, 'trash', pid, trash.length ? trash[trash.length - 1] : null),
      banished.length ? pileEl('Banished', banished.length, { click: () => trashModal(pid, 'banish'), context: () => trashModal(pid, 'banish'), title: 'Click: look at banished cards (out of the game)' }, 'banish', pid, banished[banished.length - 1]) : null);

    const champ = zoneCards(key('champion'));
    const leader = h('div', { class: 'heroes' }, zoneEl(key('leader'), 'leader', 'Superhorse', pid),
      champ.length ? zoneEl(key('champion'), 'champion', 'Champion', pid) : null);
    const base = zoneEl(key('base'), 'base', 'Base', pid);
    const pool = zoneEl(key('pool'), 'pool', 'Star pool', pid, true);
    // Quick pay: exhaust N ready Stars in one click (or click Stars one by one).
    if (mine) {
      const poolCards = zoneCards(key('pool'));
      const ready = poolCards.filter(c => !c.exhausted && !c.mask).length;
      const lbl = pool.querySelector('.zone-label');
      if (lbl) { lbl.textContent = `Stars ${ready}/${poolCards.length}`; lbl.title = `${ready} of ${poolCards.length} Stars ready`; }
      pool.append(h('div', { class: 'pool-pay', title: 'Exhaust this many ready Stars' },
        h('span', null, 'Pay'),
        [1, 2, 3, 4].map(n => h('button', { class: 'chip-btn', disabled: n > ready, on: { click: e => { e.stopPropagation(); act('payStars', n); } } }, n)),
        h('button', { class: 'chip-btn', disabled: ready === poolCards.length, title: 'Ready all your Stars', on: { click: e => { e.stopPropagation(); act('readyStars'); } } }, '↺')));
    }

    // Your hand fans out along the bottom of the screen, tilted like real cards.
    const n = hand.length;
    const handCards = hand.map((c, i) => {
      const el = cardEl(c);
      if (mine) {
        const off = i - (n - 1) / 2;
        const spread = Math.min(5, 36 / Math.max(n, 1));
        el.style.setProperty('--rot', (off * spread).toFixed(2) + 'deg');
        el.style.setProperty('--lift', (off * off * Math.min(3.2, 22 / Math.max(n, 1))).toFixed(1) + 'px');
        el.style.zIndex = String(i + 1);
      }
      return el;
    });
    const handEl = h('div', {
      class: 'hand' + (mine ? ' mine fan' : ''), dataset: mine ? { drop: 'hand', owner: pid, overlap: n > 9 ? '-0.5' : n > 6 ? '-0.38' : '-0.22' } : {},
      style: mine ? { '--overlap': n > 9 ? '-0.5' : n > 6 ? '-0.38' : '-0.22' } : null,
    },
      h('span', { class: 'zone-label' }, `Hand · ${hand.length}`),
      h('div', { class: 'hand-cards' }, handCards));
    bindDrop(handEl, pid);

    // The other player's hand only takes a row when it's revealed; otherwise
    // its size is shown in the turn bar, to keep the board on one screen.
    if (compact) {
      // 3–4 players: a smaller panel per opponent.
      const st = S().phase === 'ramp' && S().step < Game.CHECK(S()) ? Game.stepInfo(S()) : null;
      return h('div', { class: 'side opp compact' + (st && st.who === pid ? ' acting' : '') + (p.out ? ' out' : ''), style: { '--pc': seatColor(pid) } },
        h('div', { class: 'compact-head' },
          h('span', { class: 'seat-dot' }), h('strong', null, p.name), p.out ? h('span', { class: 'pill' }, 'Out') : null,
          h('span', { class: 'muted' }, `${hand.length} in hand · ${deckN} deck`),
          st && st.who === pid ? h('span', { class: 'pill live' }, st.kind === 'tricks' ? 'Tricks' : 'Units') : null),
        p.revealHand ? handEl : null,
        h('div', { class: 'side-row' }, fans, leader, base, pool, piles));
    }
    return h('div', { class: 'side ' + (isOpp ? 'opp' : 'me') },
      isOpp && p.revealHand ? handEl : null,
      h('div', { class: 'side-row' }, fans, leader, base, pool, piles),
      isOpp ? null : handEl);
  }

  const sleeveOf = pid => (S().players[pid] || {}).sleeve || null;

  function pileEl(label, n, handlers, drop, pid, topCard) {
    const face = topCard && !Game.isHidden(S(), topCard, me()) ? Cards.render(def(topCard), { size: 's', title: false }) : (n ? Cards.renderBack('s', '', sleeveOf(pid)) : h('div', { class: 'pile-empty' }));
    const on = {};
    if (handlers && handlers.click) on.click = handlers.click;
    if (handlers && handlers.context) on.contextmenu = e => { e.preventDefault(); handlers.context(); };
    const el = h(handlers ? 'button' : 'div', { class: 'pile', title: handlers ? handlers.title : null, on,
      dataset: { ...(drop ? { drop, owner: pid } : {}), pile: label.toLowerCase(), pileOwner: pid } },
      face,
      h('span', { class: 'pile-label' }, `${label} · ${n}`));
    if (drop) bindDrop(el, pid);
    return el;
  }

  function zoneEl(key, dest, label, pid, stars = false) {
    const cards = zoneCards(key).filter(c => !c.attachedTo || !S().cards[c.attachedTo] || S().cards[c.attachedTo].zone !== key);
    const el = h('div', { class: `zone zone-${dest}`, dataset: { drop: dest, owner: pid || '' } },
      h('span', { class: 'zone-label' }, label),
      h('div', { class: 'zone-cards' + (stars ? ' stars' : ''), style: stars ? { '--n': cards.length } : null }, cards.map(c => cardEl(c))));
    bindDrop(el, pid);
    return el;
  }

  function lanesEl() {
    const s = S();
    const lanes = s.phase === 'race' ? ['race'] : ['mini0', 'mini1'];
    const my = me();
    const op = Game.opp(s, my);
    return h('div', { class: 'lanes' + (s.miniFight ? ' fighting' : '') },
      lanes.map(l => {
        const all = zoneCards('lane:' + l).filter(c => !c.attachedTo || !s.cards[c.attachedTo] || s.cards[c.attachedTo].zone !== 'lane:' + l);
        const mightBy = pid => all.filter(c => c.owner === pid).reduce((a, c) => a + mightOf(c), 0);
        const rivals = rivalsOf(s, my);
        const multi = rivals.length > 1;
        const mightText = multi
          ? [...rivals, my].map(pid => `${pid === my ? 'You' : Game.nameOf(s, pid)} ${mightBy(pid)}`).join(' · ')
          : `${mightBy(op)} vs ${mightBy(my)}`;
        // environment slot(s): one per mini lane; the Race lane shows both
        const slots = l === 'race' ? Game.ENV_SLOTS : ['env:' + l];
        const tint = {};
        const envEls = slots.map((k, i) => {
          const env = zoneCards(k)[0];
          if (env) tint[i ? '--env2' : '--env1'] = `var(--t-${(def(env).types || ['wit'])[0]})`;
          // An Environment waiting on the chain shows where it's headed.
          const coming = (s.chain || []).filter(it => it.dest === k && it.kind === 'play').pop();
          const box = h('div', { class: `lane-env ${i ? 'right' : 'left'}${env ? ' filled' : ''}${coming ? ' incoming' : ''}`, dataset: { drop: k },
            title: coming ? `${def(s.cards[coming.iid]).name} is coming here (on the chain)` : env ? null : `Drop an Environment here (${Game.ENV_LABEL[k]})` },
            h('span', { class: 'env-label' }, l === 'race' ? `Env · ${i ? 'Lane 2' : 'Lane 1'}` : 'Environment'),
            env ? cardEl(env) : h('div', { class: 'env-empty', 'aria-hidden': 'true' }, '☁'),
            coming ? h('span', { class: 'env-incoming', role: 'status' }, `▼ ${def(s.cards[coming.iid]).name}${env ? ' (replaces)' : ''}`) : null);
          bindDrop(box, null);
          return box;
        });
        const sd = s.showdown && s.showdown.active && ((s.showdown.lanes || [s.showdown.lane]).includes(l) || l === 'race');
        const el = h('div', { class: 'lane lane-' + l + (Object.keys(tint).length ? ' has-env' : '') + (sd ? ' showdown' : ''), dataset: { drop: l }, style: tint },
          h('div', { class: 'lane-head' }, h('span', { class: 'lane-name' }, Game.LANE_LABEL[l]),
            h('span', { class: 'lane-might', title: 'Total might (face-up units)' }, mightText)),
          envEls,
          multi
            ? h('div', { class: 'lane-half opp grouped' }, rivals.map(pid => {
                const mine = all.filter(c => c.owner === pid);
                return mine.length ? h('div', { class: 'lane-group', style: { '--pc': seatColor(pid) } },
                  h('span', { class: 'lane-group-name' }, Game.nameOf(s, pid)), mine.map(c => cardEl(c))) : null;
              }))
            : h('div', { class: 'lane-half opp' }, all.filter(c => c.owner === op).map(c => cardEl(c))),
          h('div', { class: 'lane-rail', 'aria-hidden': 'true' }),
          h('div', { class: 'lane-half me' }, all.filter(c => c.owner === my).map(c => cardEl(c))));
        bindDrop(el, null);
        return el;
      }));
  }

  // Channel: new Stars fly from the Stars pile into the pool.
  // Recycle: a Star leaving the pool flies back to the pile.
  function animateStars(prevStars) {
    const s = S();
    const now = new Set();
    for (const pid of s.order) for (const iid of s.zones[pid + ':pool'] || []) now.add(iid);
    const before = ui.prevPool;
    ui.prevPool = now;
    if (!before || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const pileRect = pid => {
      const p = ui.el.querySelector(`.pile[data-pile="stars"][data-pile-owner="${pid}"]`);
      return p ? p.getBoundingClientRect() : null;
    };
    let n = 0;
    for (const iid of now) {
      if (before.has(iid)) continue;
      const el = ui.el.querySelector(`.zone-pool .slot[data-iid="${iid}"]`);
      const from = pileRect(s.cards[iid].owner);
      if (!el || !from) continue;
      const to = el.getBoundingClientRect();
      const dx = from.left + from.width / 2 - (to.left + to.width / 2), dy = from.top + from.height / 2 - (to.top + to.height / 2);
      el.animate([
        { transform: `translate(${dx}px, ${dy}px) scale(.55) rotate(-25deg)`, opacity: 0, filter: 'brightness(2)' },
        { opacity: 1, offset: .25 },
        { transform: 'translate(0, 0) scale(1.12) rotate(4deg)', filter: 'brightness(1.6)', offset: .75 },
        { transform: 'none', opacity: 1, filter: 'none' },
      ], { duration: 620, delay: n * 110, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' });
      const glow = el.animate([{ boxShadow: '0 0 0 0 rgba(255,214,102,0)' }, { boxShadow: '0 0 18px 6px rgba(255,214,102,.75)' }, { boxShadow: '0 0 0 0 rgba(255,214,102,0)' }],
        { duration: 700, delay: n * 110 + 420 });
      n++;
    }
    let m = 0;
    for (const iid of before) {
      if (now.has(iid)) continue;
      const c = s.cards[iid];
      const prev = prevStars.get(iid);
      if (!c || !prev || Game.zoneKind(c.zone) !== 'stars') continue; // only recycles fly back
      const to = pileRect(c.owner);
      if (!to) continue;
      const ghost = prev.node;
      ghost.classList.add('star-ghost');
      Object.assign(ghost.style, { position: 'fixed', left: prev.rect.left + 'px', top: prev.rect.top + 'px', width: prev.rect.width + 'px', height: prev.rect.height + 'px', margin: 0, zIndex: 60, pointerEvents: 'none' });
      document.body.append(ghost);
      const dx = to.left + to.width / 2 - (prev.rect.left + prev.rect.width / 2), dy = to.top + to.height / 2 - (prev.rect.top + prev.rect.height / 2);
      ghost.animate([
        { transform: 'none', opacity: 1 },
        { transform: `translate(${dx * .15}px, ${dy * .15 - 24}px) scale(1.1) rotate(-10deg)`, opacity: 1, offset: .3 },
        { transform: `translate(${dx}px, ${dy}px) scale(.45) rotate(30deg)`, opacity: 0 },
      ], { duration: 560, delay: m * 90, easing: 'cubic-bezier(.5,0,.6,1)', fill: 'forwards' }).finished.then(() => ghost.remove(), () => ghost.remove());
      m++;
    }
  }

  const auraOf = c => { try { return Game.auraMight(S(), ui.defs, c, ui.mods); } catch (e) { return 0; } };
  function mightOf(c) {
    if (c.faceDown && c.owner !== me()) return 0;
    const d = def(c);
    const aura = Game.BOARD.includes(Game.zoneKind(c.zone)) ? auraOf(c) : 0;
    if (!Cards.hasMight(d)) return (c.might || 0) + (c.tmp || 0) + aura;
    return Number(d.might) + (c.might || 0) + (c.tmp || 0) + aura;
  }

  // Card code changes, drawn onto a card face: cost badges and might.
  function codeMarks(face, c, d, kind) {
    if (!ui.mods || !ui.mods.length) return;
    const s = S();
    const eff = Game.effCost(s, ui.defs, c, 'energy', ui.mods);
    const base = Number(d.energy || 0);
    const ce = face.querySelector('.card-costs .cost-e');
    if (ce && eff !== base) {
      ce.textContent = eff;
      ce.classList.add(eff > base ? 'mod-up' : 'mod-down');
      ce.title = `Energy cost ${eff} right now (printed ${base}), changed by a card in play`;
    }
    const pe = Game.effCost(s, ui.defs, c, 'power', ui.mods);
    const pb = Number(d.power || 0);
    const costs = face.querySelector('.card-costs');
    if (costs && pe !== pb) costs.append(h('span', { class: 'cost-pmod ' + (pe > pb ? 'mod-up' : 'mod-down'), title: `Power cost ${pe} right now (printed ${pb})` }, `${pe > pb ? '+' : '−'}${Math.abs(pe - pb)}★`));
    if (Game.BOARD.includes(kind)) {
      const aura = auraOf(c);
      const mt = face.querySelector('.card-might');
      if (aura && mt && Cards.hasMight(d)) {
        const total = Number(d.might) + (c.might || 0) + aura;
        mt.querySelector('.might-n').textContent = total;
        mt.classList.remove('up', 'down');
        mt.classList.add(total > Number(d.might) ? 'up' : 'down');
      }
    }
  }

  function cardEl(c) {
    const s = S();
    const hidden = Game.isHidden(s, c, me());
    const d = def(c);
    const kind = Game.zoneKind(c.zone);
    let face;
    if (hidden) face = Cards.renderBack('s', '', sleeveOf(c.owner));
    else if (d.card_type === 'star') face = Cards.renderStar(d.types[0], 's');
    else {
      face = Cards.render(d, { size: 's' });
      const mt = face.querySelector('.card-might');
      if (c.might && Cards.hasMight(d) && mt) {
        mt.querySelector('.might-n').textContent = Number(d.might) + c.might;
        mt.classList.add(c.might > 0 ? 'up' : 'down');
      } else if (c.might && !Cards.hasMight(d)) {
        face.append(h('div', { class: 'card-might ' + (c.might > 0 ? 'up' : 'down') }, h('span', { class: 'might-n' }, (c.might > 0 ? '+' : '') + c.might)));
      }
      codeMarks(face, c, d, kind);
    }
    const newPing = (s.pings || []).some(p => p.iid === c.iid && !ui.seenPings.has(p.n));
    const canDrag = canMove(c);
    const kids = Game.attachmentsOf(s, c.iid).map(k => s.cards[k]).filter(k => k.zone === c.zone);
    const prevEx = ui.prevEx.get(c.iid);
    const nowEx = Game.shownExhausted(c, me());
    const animate = prevEx !== undefined && prevEx !== nowEx && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const shownEx = animate ? prevEx : nowEx;
    const slot = h('div', {
      class: ['slot', shownEx ? 'ex' : '', c.faceDown ? 'fd' : '', newPing ? 'pinged' : '',
        ui.pick && ui.pick.iid === c.iid ? 'picking-src' : '', d.card_type === 'star' ? 'is-star' : '', ui.sel.has(c.iid) ? 'selected' : ''].filter(Boolean).join(' '),
      dataset: { iid: c.iid },
      draggable: canDrag ? 'true' : null,
      tabindex: '0',
      role: 'button',
      'aria-label': hidden ? 'Hidden card' : `${d.name}${nowEx ? ', exhausted' : ''}${c.dmg ? ', ' + c.dmg + ' damage' : ''}${c.tmp ? `, ${c.tmp > 0 ? '+' : ''}${c.tmp} temporary might` : ''}`,
      on: {
        click: e => {
          e.stopPropagation();
          if (ui.suppressClick) { ui.suppressClick = false; return; }
          if (e.shiftKey || e.ctrlKey || e.metaKey) { toggleSel(c); return; }
          primaryAction(c, e.currentTarget);
        },
        contextmenu: e => { e.preventDefault(); e.stopPropagation(); secondaryAction(c, e.currentTarget); },
        keydown: e => { if (e.key === 'Enter') { e.preventDefault(); primaryAction(c, e.currentTarget); } },
        // Long-press on touch screens = right-click.
        pointerdown: e => {
          if (e.pointerType !== 'touch') return;
          const target = e.currentTarget;
          clearTimeout(ui.longPress);
          ui.longPress = setTimeout(() => { ui.suppressClick = true; secondaryAction(c, target); }, 480);
        },
        pointerup: () => clearTimeout(ui.longPress),
        pointercancel: () => clearTimeout(ui.longPress),
        pointermove: e => { if (e.pointerType === 'touch' && (Math.abs(e.movementX) > 4 || Math.abs(e.movementY) > 4)) clearTimeout(ui.longPress); },
        mouseenter: e => { if (!hidden || (c.faceDown && c.owner === me())) { showInspect(c); showPeek(c, e.currentTarget); } },
        mouseleave: hidePeek,
        dragstart: e => { e.dataTransfer.setData('text/plain', c.iid); e.dataTransfer.effectAllowed = 'move'; closeMenu(); hidePeek(); },
      },
    },
      h('div', { class: 'slot-inner' }, face),
      c.dmg ? h('span', { class: 'dmg', title: 'Damage' }, c.dmg) : null,
      c.tmp ? h('span', { class: 'tmp-might ' + (c.tmp > 0 ? 'up' : 'down'), title: 'Temporary might (stays until you change or clear it)' }, (c.tmp > 0 ? '+' : '') + c.tmp) : null,
      c.faceDown && !hidden ? h('span', { class: 'tag' }, c.paid ? `Face-down · paid ${c.paid.energy}${c.paid.power ? '+' + c.paid.power + 'P' : ''}` : 'Face-down') : null,
      c.mask && c.owner === me() ? h('span', { class: 'tag reserved', title: 'Paid for a face-down card. Your opponent sees this when it is revealed.' }, c.mask.recycle ? 'Recycles on reveal' : 'Hidden cost') : null,
      c.conjured && !hidden ? h('span', { class: 'tag conj' }, 'Conjured') : null,
      kids.length ? h('div', { class: 'attached' }, kids.map(k => cardEl(k))) : null);
    if (animate) ui.anims.push({ el: slot, to: nowEx });
    return slot;
  }

  // Who may drag/move a card: your own cards anywhere, anyone's face-up cards on the board.
  function canMove(c) {
    const kind = Game.zoneKind(c.zone);
    if (c.owner === me()) return true;
    return Game.BOARD.includes(kind) && kind !== 'leader';
  }

  function bindDrop(el, pid) {
    el.addEventListener('dragover', e => {
      if (!el.dataset.drop) return;
      if (el.dataset.owner && el.dataset.owner !== me() && !['base'].includes(el.dataset.drop)) return;
      e.preventDefault();
      el.classList.add('drop-hover');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-hover'));
    el.addEventListener('drop', e => {
      el.classList.remove('drop-hover');
      const iid = e.dataTransfer.getData('text/plain');
      if (!iid || !el.dataset.drop) return;
      e.preventDefault();
      e.stopPropagation();
      const c = S().cards[iid];
      if (!c) return;
      const dest = el.dataset.drop;
      // Dragging one of several selected cards moves them all.
      if (ui.sel.has(iid) && ui.sel.size > 1) {
        const plans = selCards().map(x => dropPlan(x, dest, el.dataset.owner)).filter(p => Array.isArray(p));
        if (!plans.length) return U.toast("Those cards can't go there.", 'error');
        act('batch', plans);
        return;
      }
      const plan = dropPlan(c, dest, el.dataset.owner);
      if (typeof plan === 'string') return U.toast(plan, 'error');
      if (plan) act(...plan);
    });
  }

  // What dropping card c on a zone does: an action [name, ...args], an error
  // message (string), or null for nothing.
  function dropPlan(c, dest, zoneOwner) {
    const iid = c.iid;
    if (dest === 'pool' && def(c).card_type !== 'star') return 'Only Stars go in the Star pool.';
    if (dest !== 'pool' && def(c).card_type === 'star' && dest !== 'trash') return 'Stars stay in the Star pool. Use Recycle to send one back.';
    if (zoneOwner && zoneOwner !== c.owner && ['base', 'hand', 'trash', 'deck-top', 'banish', 'champion'].includes(dest)) {
      return "Cards go to their owner's zones. Use Give to hand a card over.";
    }
    if (c.zone === (Game.LANES.includes(dest) ? 'lane:' + dest : `${c.owner}:${dest}`)) return null;
    // From your hand onto the table = playing it (goes on the chain).
    const fromHand = ['hand', 'champion'].includes(Game.zoneKind(c.zone)) && c.owner === me();
    const isEnv = Cards.isEnvironment(def(c));
    if (Game.ENV_SLOTS.includes(dest) && !isEnv) return 'Only Environment cards go in the environment slot.';
    // An environment dropped on a mini lane goes into that lane's environment slot.
    if (isEnv && fromHand && (dest === 'mini0' || dest === 'mini1')) return ['play', iid, 'env:' + dest];
    if (fromHand && (Game.ENV_SLOTS.includes(dest) || (Game.BOARD.includes(dest) && dest !== 'pool'))) return ['play', iid, dest];
    return ['move', iid, dest];
  }

  // ---------- floating Energy / Power ----------
  // What you can spend right now (ready Stars, Stars by type) plus a pool of
  // floating Energy / Power that effects made and you haven't spent yet.
  function floatEl() {
    const s = S();
    const my = me();
    if (s.phase === 'mulligan') return null;
    const pool = (s.zones[my + ':pool'] || []).map(i => s.cards[i]);
    const ready = pool.filter(c => !c.exhausted && !c.mask).length;
    const byType = {};
    for (const c of Object.values(s.cards)) if (c.owner === my && def(c).card_type === 'star') byType[def(c).types[0]] = 0;
    for (const c of pool) if (!c.mask) byType[def(c).types[0]] = (byType[def(c).types[0]] || 0) + 1;
    const types = Object.keys(byType);
    const fl = s.players[my].float || { energy: 0, power: {} };
    const any = fl.energy || Object.values(fl.power || {}).some(Boolean);
    const SHORT = { speed: 'Spd', stamina: 'Sta', power: 'Pow', guts: 'Gut', wit: 'Wit' };
    const step = (kind, type, n, label, color) => h('span', { class: 'fl-item', style: color ? { '--c1': color } : null },
      h('button', { class: 'fl-btn', 'aria-label': `${label} minus 1`, disabled: !n, on: { click: () => act('floatAdj', kind, type, -1) } }, '−'),
      h('span', { class: 'fl-n' + (n ? ' on' : '') }, n), h('span', { class: 'fl-lbl' }, label),
      h('button', { class: 'fl-btn', 'aria-label': `${label} plus 1`, on: { click: () => act('floatAdj', kind, type, 1) } }, '+'));
    const handle = h('span', { class: 'fl-handle', title: 'Drag to move', 'aria-hidden': 'true' }, '⠿');
    const box = h('div', { class: 'float-box' + (any ? ' has' : ''), role: 'group', 'aria-label': 'Energy and Power',
      style: ui.floatPos ? { left: ui.floatPos.x + 'px', top: ui.floatPos.y + 'px', right: 'auto', bottom: 'auto' } : null },
      h('div', { class: 'fl-row fl-avail', title: 'Have: ready Stars (Energy) and Stars in your pool by type (Power)' },
        handle,
        h('span', { class: 'fl-big' }, h('b', null, ready), ' Energy'),
        types.map(t => h('span', { class: 'fl-type', style: { '--c1': `var(--t-${t})` } }, h('b', null, byType[t]), ' ', SHORT[t] || t))),
      h('div', { class: 'fl-row', title: 'Floating: Energy / Power made by effects (e.g. a Carrot) and not spent yet. Empties at the start of each Ramp.' },
        h('span', { class: 'fl-head' }, 'Float'),
        step('energy', null, fl.energy || 0, 'E'),
        types.map(t => step('power', t, (fl.power || {})[t] || 0, SHORT[t] || t, `var(--t-${t})`)),
        any ? h('button', { class: 'fl-btn clear', title: 'Clear floating', on: { click: () => act('floatClear') } }, '✕') : null));
    // Drag the box anywhere; the spot is remembered in this browser.
    handle.addEventListener('pointerdown', e => {
      e.preventDefault();
      const r = box.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      const move = ev => {
        const x = Math.max(0, Math.min(window.innerWidth - r.width, ev.clientX - dx));
        const y = Math.max(0, Math.min(window.innerHeight - r.height, ev.clientY - dy));
        Object.assign(box.style, { left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto' });
        ui.floatPos = { x, y };
      };
      const up = () => {
        document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
        try { localStorage.setItem('uma-float-pos', JSON.stringify(ui.floatPos)); } catch (err) { /* private mode */ }
      };
      document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
    });
    return box;
  }

  // ---------- multi-select ----------
  // Shift / Ctrl / Cmd + click toggles a card; drag a box on empty table space.
  const selectable = c => c && !(Game.isHidden(S(), c, me()) && !(c.faceDown && c.owner === me())) && canMove(c);
  function selCards() {
    const s = S();
    return [...ui.sel].map(i => s.cards[i]).filter(selectable);
  }
  function toggleSel(c) {
    if (!selectable(c)) { U.toast("You can't select that card."); return; }
    if (ui.sel.has(c.iid)) ui.sel.delete(c.iid); else ui.sel.add(c.iid);
    draw();
  }
  function clearSel() { if (ui.sel.size) { ui.sel.clear(); draw(); } }

  function selBarEl() {
    const s = S();
    const list = selCards();
    for (const i of [...ui.sel]) if (!list.some(c => c.iid === i)) ui.sel.delete(i);
    if (list.length < 1) return null;
    const inPlay = list.filter(c => Game.BOARD.includes(Game.zoneKind(c.zone)));
    const movable = list.filter(c => !['leader', 'pool', 'env'].includes(Game.zoneKind(c.zone)) && def(c).card_type !== 'star');
    const run = (plans, label) => { if (!plans.length) { U.toast(`Nothing selected can ${label}.`, 'error'); return; } act('batch', plans); };
    const lanes = s.phase === 'race' ? ['race'] : ['mini0', 'mini1'];
    const b = (label, fn, cls = '') => h('button', { class: 'btn sm ' + cls, on: { click: e => { e.stopPropagation(); fn(); } } }, label);
    return h('div', { class: 'sel-bar', role: 'toolbar', 'aria-label': 'Selected cards' },
      h('strong', null, `${list.length} selected`),
      inPlay.length ? b('Exhaust', () => run(inPlay.filter(c => !c.exhausted && !c.mask).map(c => ['toggleExhaust', c.iid]), 'be exhausted')) : null,
      inPlay.length ? b('Ready', () => run(inPlay.filter(c => c.exhausted && !c.mask).map(c => ['toggleExhaust', c.iid]), 'be readied')) : null,
      movable.length ? h('span', { class: 'sel-sep' }, 'Move to') : null,
      movable.length ? [b('Base', () => run(movable.map(c => dropPlan(c, 'base')).filter(Array.isArray), 'go to base')),
        ...lanes.map(l => b(Game.LANE_LABEL[l].replace(' lane', ''), () => run(movable.map(c => dropPlan(c, l)).filter(Array.isArray), 'go there')))] : null,
      h('span', { class: 'sel-sep' }),
      b('To hand', () => run(list.filter(c => Game.zoneKind(c.zone) !== 'hand' && c.owner === me() && def(c).card_type !== 'star').map(c => ['move', c.iid, 'hand']), 'go to your hand')),
      b('Trash', () => run(list.map(c => def(c).card_type === 'star' ? null : ['trash', c.iid]).filter(Boolean), 'be trashed'), 'ghost'),
      b('Banish', () => run(list.map(c => ['banish', c.iid]), 'be banished'), 'ghost danger'),
      b('✕', clearSel, 'ghost'));
  }

  // Box select: drag across empty table space.
  function bindBoxSelect(scroller) {
    scroller.addEventListener('mousedown', e => {
      if (e.button !== 0 || e.target.closest('.slot, button, .pile, .hand, input, select, .lane-env')) return;
      const x0 = e.clientX, y0 = e.clientY;
      let box = null;
      const move = ev => {
        const dx = ev.clientX - x0, dy = ev.clientY - y0;
        if (!box && Math.hypot(dx, dy) < 6) return;
        if (!box) { box = h('div', { class: 'sel-box' }); document.body.append(box); }
        Object.assign(box.style, { left: Math.min(x0, ev.clientX) + 'px', top: Math.min(y0, ev.clientY) + 'px', width: Math.abs(dx) + 'px', height: Math.abs(dy) + 'px' });
      };
      const up = ev => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        if (!box) return;
        const r = box.getBoundingClientRect();
        box.remove();
        if (!ev.shiftKey && !ev.ctrlKey && !ev.metaKey) ui.sel.clear();
        const s = S();
        for (const el of ui.el.querySelectorAll('.board .slot[data-iid]')) {
          if (el.closest('.hand')) continue;
          const q = el.getBoundingClientRect();
          if (q.right < r.left || q.left > r.right || q.bottom < r.top || q.top > r.bottom) continue;
          const c = s.cards[el.dataset.iid];
          if (selectable(c)) ui.sel.add(c.iid);
        }
        draw();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  // ---------- card menu ----------
  // Left click: exhaust/ready your own card, ping the other player's.
  // In hand: open the menu (playing a card needs a choice).
  function primaryAction(c, anchor) {
    const s = S();
    if (ui.pick) return finishPick(c);
    const mine = c.owner === me();
    const kind = Game.zoneKind(c.zone);
    const hidden = Game.isHidden(s, c, me()) && !(c.faceDown && mine);
    if (!hidden) showInspect(c);
    if (!mine) { act('ping', c.iid); return; }
    if (kind === 'hand' || kind === 'champion') { openMenu(c, anchor); return; }
    act('toggleExhaust', c.iid);
  }

  // Right click / long-press: the full menu. Your own Stars recycle instead.
  function secondaryAction(c, anchor) {
    const s = S();
    if (ui.pick) { ui.pick = null; draw(); return; }
    const mine = c.owner === me();
    if (mine && def(c).card_type === 'star' && Game.zoneKind(c.zone) === 'pool') { act('recycle', c.iid); return; }
    if (Game.isHidden(s, c, me()) && !(c.faceDown && mine)) {
      if (!mine) openMenu(c, anchor, [{ label: 'Ping', fn: () => act('ping', c.iid) }]);
      return;
    }
    showInspect(c);
    openMenu(c, anchor);
  }

  function finishPick(c) {
    const src = ui.pick;
    ui.pick = null;
    if (src.iid === c.iid) { draw(); return; }
    if (src.kind === 'target') act('arrow', src.iid, c.iid);
    else if (Game.zoneKind(S().cards[src.iid].zone) === 'hand') act('play', src.iid, 'attach', { attachTo: c.iid });
    else act('attach', src.iid, c.iid);
  }

  function menuItems(c) {
    const s = S();
    const d = def(c);
    const kind = Game.zoneKind(c.zone);
    const mine = c.owner === me();
    const items = [];
    const sep = () => items.push(null);
    const it = (label, fn, cls) => items.push({ label, fn, cls });

    if (d.card_type === 'star') {
      it(c.exhausted ? 'Ready' : 'Exhaust', () => act('toggleExhaust', c.iid));
      if (mine) it('Recycle (to bottom of Stars)', () => act('recycle', c.iid));
      else it('Ping', () => act('ping', c.iid));
      return items;
    }

    if (kind === 'hand' || kind === 'champion') {
      if (!mine) return [{ label: kind === 'hand' ? 'This is in their hand.' : 'Their Champion (not played yet).', fn: null }];
      const isEnv = Cards.isEnvironment(d);
      const isTrick = d.card_type === 'trick' && !isEnv;
      const kws = d.keywords || [];
      if (isEnv) {
        for (const k of Game.ENV_SLOTS) {
          const cur = zoneCards(k)[0];
          it(`Set environment: ${Game.ENV_LABEL[k]}${cur ? ` (replaces ${def(cur).name})` : ''}`, () => act('play', c.iid, k), 'env');
        }
        sep();
      }
      if (isTrick) {
        // Spells go on the chain, then to the trash. Duel cards work any time too.
        it(kws.includes('duel') ? 'Cast (to the chain) · Duel' : 'Cast (to the chain)', () => act('play', c.iid, 'trash'));
        if (kws.includes('in-the-shadows')) it('Play face-down to a lane…', () => faceDownMenu(c));
        if (kws.includes('friendship')) it('Attach to a card…', () => { ui.pick = { kind: 'attach', iid: c.iid }; draw(); });
      } else if (!isEnv) {
        it('Play to base', () => act('play', c.iid, 'base'));
        it('Play to Mini lane 1', () => act('play', c.iid, 'mini0'), 'needs-ramp');
        it('Play to Mini lane 2', () => act('play', c.iid, 'mini1'), 'needs-ramp');
        it('Play to Race lane', () => act('play', c.iid, 'race'), 'needs-race');
        it('Play face-down to a lane…', () => faceDownMenu(c));
        it('Attach to a card…', () => { ui.pick = { kind: 'attach', iid: c.iid }; draw(); });
      }
      sep();
      if (kind === 'hand') {
        if (!isTrick) it('Discard (to trash)', () => act('move', c.iid, 'trash'));
        else it('Discard (to trash, without casting)', () => act('move', c.iid, 'trash'));
        it('Top of deck', () => act('move', c.iid, 'deck-top'));
        it('Bottom of deck', () => act('move', c.iid, 'deck-bottom'));
        for (const pid of rivalsOf(s, c.owner)) it(S().order.length > 2 ? `Give to ${Game.nameOf(s, pid)}` : 'Give to opponent', () => act('give', c.iid, pid));
      } else {
        it('To hand', () => act('move', c.iid, 'hand'));
      }
      it('Banish (out of the game)', () => act('banish', c.iid), 'danger');
      const cjh = conjureItems(c);
      if (cjh.length) { sep(); items.push(...cjh); }
      return items.filter(x => !x || x.cls !== 'needs-ramp' && x.cls !== 'needs-race' || (x.cls === 'needs-ramp' ? s.phase !== 'race' : s.phase === 'race'));
    }

    // on the board
    it(c.exhausted ? 'Ready' : 'Exhaust', () => act('toggleExhaust', c.iid));
    if (Cards.hasMight(d) || d.card_type === 'uma' || d.card_type === 'superhorse') {
      const base = Cards.hasMight(d) ? Number(d.might) : 0;
      items.push({ counter: 'Might', value: `${base + (c.might || 0)}${c.might ? ` (${c.might > 0 ? '+' : ''}${c.might})` : ''}`,
        minus: () => actKeep('might', c.iid, -1), plus: () => actKeep('might', c.iid, 1) });
      items.push({ counter: 'Temp might', value: c.tmp ? (c.tmp > 0 ? '+' : '') + c.tmp : '0', hint: 'Shown as a badge',
        minus: () => actKeep('tempMight', c.iid, -1), plus: () => actKeep('tempMight', c.iid, 1) });
    }
    items.push({ counter: 'Damage', value: String(c.dmg || 0), minus: () => actKeep('damage', c.iid, -1), plus: () => actKeep('damage', c.iid, 1) });
    if (c.dmg || c.might || c.tmp) it('Clear counters', () => act('clearCounters', c.iid));
    if (!mine) it('Ping', () => act('ping', c.iid));
    if (G().USE_CHAIN !== false) it('Use ability (to the chain)', () => act('ability', c.iid));
    if (mine && !c.faceDown) Game.rulesFor(ui.defs, c).forEach((r, i) => {
      if (r.kind === 'ability') it(`✦ ${r.label ? cap1(r.label) : CardCode.explain(r).replace(/^Ability: /, '')}`, () => act('codeAbility', c.iid, i), 'code-ability');
    });
    it('Target another card…', () => { ui.pick = { kind: 'target', iid: c.iid }; draw(); });
    items.push(...conjureItems(c));
    if (kind === 'env') {
      sep();
      const other = Game.ENV_SLOTS.find(k => k !== c.zone);
      it(`Move to ${Game.ENV_LABEL[other]}`, () => act('move', c.iid, other));
      it('Return to hand', () => act('move', c.iid, 'hand'));
      it('Trash', () => act('trash', c.iid), 'danger');
      it('Banish (out of the game)', () => act('banish', c.iid), 'danger');
      return items;
    }
    if (kind !== 'leader') {
      sep();
      const lanes = s.phase === 'race' ? ['race'] : ['mini0', 'mini1'];
      if (kind !== 'base') it('Move to base', () => act('move', c.iid, 'base'));
      for (const l of lanes) if (kind !== l) it('Move to ' + Game.LANE_LABEL[l], () => act('move', c.iid, l));
      if (Game.LANES.includes(kind)) it(c.faceDown ? 'Reveal (flip face-up)' : 'Flip face-down', () => act('flip', c.iid));
      if (c.attachedTo) it('Detach', () => act('detach', c.iid));
      else it('Attach to a card…', () => { ui.pick = { kind: 'attach', iid: c.iid }; draw(); });
      sep();
      it('Return to hand', () => act('move', c.iid, 'hand'));
      if (c.champion) it('Return to Champion zone', () => act('move', c.iid, 'champion'));
      it('Top of deck', () => act('move', c.iid, 'deck-top'));
      it('Trash', () => act('trash', c.iid), 'danger');
      it('Banish (out of the game)', () => act('banish', c.iid), 'danger');
      for (const pid of rivalsOf(s, c.owner)) it(S().order.length > 2 ? `Give to ${Game.nameOf(s, pid)}` : 'Give to opponent', () => act('give', c.iid, pid));
    }
    return items;
  }

  // Counter buttons keep the menu open (and update it in place).
  function actKeep(name, ...args) {
    ui.keepMenu = true;
    act(name, ...args);
  }

  // ---------- Conjure ----------
  // One menu item per Conjure on the card.
  function conjureItems(c) {
    if (c.owner !== me()) return [];
    return Cards.conjuresOf(def(c)).map(cj => ({
      label: `✦ Conjure${cj.label ? ' · ' + cj.label : ''}: ${Cards.conjureSummary(cj)}`, fn: () => doConjure(c, cj), cls: 'conjure' }));
  }

  function doConjure(c, cj) {
    cj = cj || Cards.conjureOf(def(c));
    const leader = (S().zones[me() + ':leader'] || []).map(i => S().cards[i])[0];
    const options = Cards.conjureMatches(ui.defs, cj, { src: def(c), leaderId: leader ? leader.def : null });
    if (!options.length) { U.toast('No cards in the pool match this Conjure.', 'error'); return; }
    const picks = [];
    for (let i = 0; i < cj.count; i++) picks.push(options[crypto.getRandomValues(new Uint32Array(1))[0] % options.length].id);
    act('conjureFrom', c.iid, picks, cj.dest);
    const names = picks.map(id => ui.defs[id].name).join(', ');
    U.toast(`Conjured ${names}.`, 'good');
  }

  function faceDownMenu(c) {
    const s = S();
    const lanes = s.phase === 'race' ? ['race'] : ['mini0', 'mini1'];
    const d = def(c);
    const pay = h('input', { type: 'checkbox', id: 'fd-pay', checked: true });
    const en = Game.effCost(s, ui.defs, c, 'energy', ui.mods), pw = Game.effCost(s, ui.defs, c, 'power', ui.mods);
    const m = U.modal('Play face-down', h('div', { class: 'stack' },
      h('label', { class: 'check', for: 'fd-pay' }, pay, `Pay its cost automatically (${en} energy${pw ? `, ${pw} power` : ''})`),
      h('p', { class: 'muted' }, 'For In the Shadows cards. Its cost is paid automatically from your Stars, but your opponent only sees the card back (and your Stars as they were) until it\'s revealed. Face-down cards are revealed when the next Tricks step starts.'),
      h('div', { class: 'row' }, lanes.map(l => h('button', { class: 'btn', on: { click: () => { m.close(); act('play', c.iid, l, { faceDown: true, noPay: !pay.checked }); } } }, Game.LANE_LABEL[l])))));
  }

  function openMenu(c, anchor, custom, at) {
    closeMenu();
    hidePeek();
    const items = custom || menuItems(c);
    const hidden = Game.isHidden(S(), c, me()) && !(c.faceDown && c.owner === me());
    const menu = h('div', { class: 'card-menu', role: 'menu' },
      h('div', { class: 'card-menu-title' }, hidden ? 'Hidden card' : def(c).name),
      items.map(x => {
        if (!x) return h('hr');
        if (x.counter) return h('div', { class: 'counter-row', title: x.hint || null },
          h('span', null, x.counter, x.hint ? h('small', null, x.hint) : null),
          h('button', { class: 'icon-btn sm', 'aria-label': x.counter + ' minus 1', dataset: { k: x.counter + '-' }, on: { click: e => { e.stopPropagation(); x.minus(); } } }, '−'),
          h('span', { class: 'counter-val', 'aria-live': 'polite' }, x.value ?? ''),
          h('button', { class: 'icon-btn sm', 'aria-label': x.counter + ' plus 1', dataset: { k: x.counter + '+' }, on: { click: e => { e.stopPropagation(); x.plus(); } } }, '+'));
        if (!x.fn) return h('div', { class: 'muted menu-note' }, x.label);
        return h('button', { class: 'menu-item' + (x.cls === 'danger' ? ' danger' : '') + (x.cls === 'conjure' ? ' conjure' : '') + (x.cls === 'env' ? ' env' : '') + (x.cls === 'code-ability' ? ' code-ability' : ''), role: 'menuitem', on: { click: e => { e.stopPropagation(); closeMenu(); x.fn(); } } }, x.label);
      }));
    document.body.append(menu);
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let left, top;
    if (at) ({ left, top } = at);
    else {
      const r = anchor.getBoundingClientRect();
      left = r.right + 8; top = r.top;
      if (left + mw > window.innerWidth - 8) left = Math.max(8, r.left - mw - 8);
    }
    if (top + mh > window.innerHeight - 8) top = Math.max(8, window.innerHeight - mh - 8);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    ui.menu = menu;
    ui.menuFor = custom ? null : { iid: c.iid, left, top };
    setTimeout(() => document.addEventListener('click', closeMenuOnOutside), 0);
    const first = menu.querySelector('button');
    if (first && !at) first.focus({ preventScroll: true });
  }

  // Re-draw the open card menu (same place) after a counter changed.
  function refreshMenu() {
    if (!ui || !ui.menu || !ui.menuFor) return;
    const { iid, left, top } = ui.menuFor;
    const c = S().cards[iid];
    const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.k : null;
    if (!c) { closeMenu(); return; }
    openMenu(c, null, null, { left, top });
    if (focused) { const b = ui.menu.querySelector(`[data-k="${CSS.escape(focused)}"]`); if (b) b.focus({ preventScroll: true }); }
  }
  function closeMenuOnOutside(e) { if (ui && ui.menu && !ui.menu.contains(e.target)) closeMenu(); }
  function closeMenu() {
    document.removeEventListener('click', closeMenuOnOutside);
    if (ui && ui.menu) { ui.menu.remove(); ui.menu = null; ui.menuFor = null; }
  }

  // ---------- piles ----------
  function deckMenu(pid) {
    const lookN = h('input', { id: 'look-n', type: 'number', min: 1, max: 20, step: 1, value: 3 });
    const m = U.modal('Your deck', h('div', { class: 'stack' },
      h('p', { class: 'muted' }, `${(S().zones[pid + ':deck'] || []).length} cards left.`),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn', on: { click: () => { m.close(); act('draw', 1); } } }, 'Draw 1'),
        h('button', { class: 'btn', on: { click: () => { m.close(); act('shuffleDeck'); } } }, 'Shuffle'),
        h('button', { class: 'btn', on: { click: () => { m.close(); searchDeck(pid); } } }, 'Look through deck…')),
      h('div', { class: 'row wrap look-top' },
        h('label', { for: 'look-n' }, 'Look at the top'), lookN, h('span', null, 'cards'),
        h('button', { class: 'btn primary', on: { click: () => { m.close(); lookTop(pid, Math.max(1, Math.min(20, Number(lookN.value) || 3))); } } }, 'Look'))));
    lookN.focus();
  }

  // Look at the top N cards: move each one, or leave it. The window stays
  // open until you're done, so you can sort through them one by one.
  function lookTop(pid, n) {
    const s = S();
    const ids = (s.zones[pid + ':deck'] || []).slice(0, n);
    if (!ids.length) { U.toast('Your deck is empty.', 'error'); return; }
    act('note', `looked at the top ${ids.length} card${ids.length > 1 ? 's' : ''} of their deck`);
    const body = h('div', { class: 'stack' });
    const drawList = () => {
      const st = S();
      const deck = st.zones[pid + ':deck'] || [];
      const left = deck.filter(iid => ids.includes(iid));
      const mv = (iid, dest) => () => { (dest === 'banish' ? act('banish', iid) : act('move', iid, dest)); drawList(); };
      body.replaceChildren(
        h('p', { class: 'muted' }, left.length ? 'Top of the deck first. Use "To top" to put cards back in the order you want (the last one you send ends up on top).' : 'Done: all of them were moved.'),
        h('div', { class: 'pile-list' }, left.map(iid => {
          const c = st.cards[iid];
          return h('div', { class: 'pile-item' },
            h('span', { class: 'pile-pos' }, '#' + (deck.indexOf(iid) + 1)),
            Cards.render(def(c), { size: 's' }),
            h('div', { class: 'stack tight' },
              h('button', { class: 'btn sm', on: { click: mv(iid, 'hand') } }, 'To hand'),
              h('button', { class: 'btn sm ghost', on: { click: mv(iid, 'deck-top') } }, 'To top'),
              h('button', { class: 'btn sm ghost', on: { click: mv(iid, 'deck-bottom') } }, 'To bottom'),
              h('button', { class: 'btn sm ghost', on: { click: mv(iid, 'trash') } }, 'Trash'),
              h('button', { class: 'btn sm ghost danger', on: { click: mv(iid, 'banish') } }, 'Banish')));
        })),
        h('div', { class: 'row end' }, h('button', { class: 'btn primary', on: { click: () => m.close() } }, 'Done')));
    };
    const m = U.modal(`Top ${ids.length} of your deck`, body, { wide: true });
    drawList();
  }

  function searchDeck(pid) {
    const s = S();
    const list = (s.zones[pid + ':deck'] || []).map(iid => s.cards[iid]);
    act('note', 'looked through their deck');
    const m = U.modal('Look through deck (top first)', h('div', { class: 'pile-list' }, list.map(c => h('div', { class: 'pile-item' },
      Cards.render(def(c), { size: 's' }),
      h('div', { class: 'stack tight' },
        h('button', { class: 'btn sm', on: { click: () => { m.close(); act('move', c.iid, 'hand'); } } }, 'To hand'),
        h('button', { class: 'btn sm ghost', on: { click: () => { m.close(); act('move', c.iid, 'trash'); } } }, 'Trash'),
        h('button', { class: 'btn sm ghost', on: { click: () => { m.close(); act('move', c.iid, 'deck-bottom'); } } }, 'Bottom'),
        h('button', { class: 'btn sm ghost danger', on: { click: () => { m.close(); act('banish', c.iid); } } }, 'Banish'))))), { wide: true });
  }

  // Trash: just the cards. Right-click (or long-press) one for its options,
  // including Conjure for spells that have already resolved.
  function trashModal(pid, zone = 'trash') {
    const s = S();
    const list = (s.zones[pid + ':' + zone] || []).map(iid => s.cards[iid]).reverse();
    const mine = pid === me();
    let m;
    const options = (c, anchor) => {
      if (!mine) return;
      const close = fn => () => { m.close(); fn(); };
      const items = [
        { label: 'To hand', fn: close(() => act('move', c.iid, 'hand')) },
        { label: 'To base', fn: close(() => act('move', c.iid, 'base')) },
        { label: 'Top of deck', fn: close(() => act('move', c.iid, 'deck-top')) },
        { label: 'Bottom of deck', fn: close(() => act('move', c.iid, 'deck-bottom')) },
        zone === 'trash' ? { label: 'Banish (out of the game)', fn: close(() => act('banish', c.iid)), cls: 'danger' }
          : { label: 'To trash', fn: close(() => act('move', c.iid, 'trash')) },
      ];
      const cjs = conjureItems(c);
      if (cjs.length) items.push(null, ...cjs.map(x => ({ ...x, fn: close(x.fn) })));
      openMenu(c, anchor, items);
    };
    const grid = list.length ? h('div', { class: 'trash-grid' }, list.map(c => {
      let press;
      const el = h('div', {
        class: 'trash-card' + (Cards.conjureOf(def(c)) && mine ? ' has-conjure' : ''), tabindex: '0',
        title: mine ? 'Right-click for options' : null,
        on: {
          contextmenu: e => { e.preventDefault(); options(c, e.currentTarget); },
          keydown: e => { if (e.key === 'Enter' || e.key === 'ContextMenu') { e.preventDefault(); options(c, e.currentTarget); } },
          mouseenter: e => showPeek(c, e.currentTarget),
          mouseleave: hidePeek,
          pointerdown: e => { if (e.pointerType === 'touch') { const t = e.currentTarget; press = setTimeout(() => options(c, t), 480); } },
          pointerup: () => clearTimeout(press),
          pointercancel: () => clearTimeout(press),
        },
      }, Cards.render(def(c), { size: 's' }));
      return el;
    })) : h('p', { class: 'muted' }, 'Empty.');
    m = U.modal(`${Game.nameOf(s, pid)}'s ${zone === 'trash' ? 'trash' : 'banished cards'} · ${list.length}`, [
      mine && zone === 'trash' && list.length ? h('div', { class: 'row end trash-tools' },
        h('button', { class: 'btn', title: 'Shuffle your whole trash and put it on the bottom of your deck', on: { click: () => { m.close(); act('recycleTrash'); } } }, `Recycle all (${list.length}) to the bottom of your deck`)) : null,
      grid,
      list.length && mine ? h('p', { class: 'hint' }, 'Right-click a card (long-press on touch) for its options. Cards that can Conjure are marked ✦.') : null,
    ], { wide: true, onClose: () => { hidePeek(); closeMenu(); } });
  }

  // Tokens for this match: your pool's tokens (from when the match started),
  // plus built-in ones nobody has replaced with a same-named token.
  function matchTokens() {
    const all = Object.values(ui.defs).filter(d => Cards.isToken(d));
    const custom = all.filter(d => !String(d.id).startsWith('token:'));
    return [...custom, ...all.filter(d => String(d.id).startsWith('token:') && !custom.some(c => c.name.toLowerCase() === d.name.toLowerCase()))];
  }

  // Create tokens: pick how many, ready or not, and where they go.
  function tokenModal() {
    const s = S();
    const lanes = s.phase === 'race' ? ['race'] : ['mini0', 'mini1'];
    const count = h('input', { id: 'tk-count', type: 'number', min: 1, max: 10, step: 1, value: 1 });
    const ready = h('input', { id: 'tk-ready', type: 'checkbox' });
    let m;
    const make = (id, dest) => () => {
      m.close();
      act('createToken', id, dest, Math.max(1, Math.min(10, Number(count.value) || 1)), ready.checked);
    };
    m = U.modal('Create a token', h('div', { class: 'stack' },
      h('div', { class: 'row wrap token-opts' },
        h('label', { for: 'tk-count' }, 'How many'), count,
        h('label', { class: 'check', for: 'tk-ready' }, ready, 'Enter ready (units normally enter exhausted)')),
      h('div', { class: 'token-list' }, matchTokens().map(t => h('div', { class: 'token-item' },
        Cards.render(t, { size: 'm' }),
        h('div', { class: 'stack tight' },
          h('button', { class: 'btn primary sm', on: { click: make(t.id, 'base') } }, 'To base'),
          lanes.map(l => h('button', { class: 'btn sm', on: { click: make(t.id, l) } }, 'To ' + Game.LANE_LABEL[l])))))),
      h('p', { class: 'hint' }, 'Tokens only exist in play. If one would go to your hand, deck or trash, it is removed instead. Make your own tokens (or customize these) in Card pool → New token; they show up in matches started after that.')), { wide: true });
    count.focus();
  }

  function conjureModal() {
    const defs = Object.values(ui.defs).filter(d => d.card_type !== 'star' && d.card_type !== 'superhorse' && !Cards.isToken(d));
    const search = h('input', { id: 'cj-search', type: 'search', placeholder: 'Search by name, type or text' });
    const grid = h('div', { class: 'pile-list' });
    const drawList = () => {
      const q = search.value.trim().toLowerCase();
      grid.replaceChildren(...defs.filter(d => !q || d.name.toLowerCase().includes(q) || (d.effect || '').toLowerCase().includes(q) ||
        d.types.some(t => t.includes(q)) || d.card_type.includes(q)).slice(0, 60).map(d => h('div', { class: 'pile-item' },
        Cards.render(d, { size: 's' }),
        h('div', { class: 'stack tight' },
          h('button', { class: 'btn sm', on: { click: () => { m.close(); act('conjure', d.id, 'hand'); } } }, 'To hand'),
          h('button', { class: 'btn sm ghost', on: { click: () => { m.close(); act('conjure', d.id, 'base'); } } }, 'To base')))));
    };
    search.addEventListener('input', drawList);
    const m = U.modal('Conjure a card', h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'Creates a new copy from the card pool. Check that it fits the Conjure effect you are resolving.'),
      search, grid), { wide: true });
    drawList();
    search.focus();
  }

  // ---------- sidebar ----------
  // The fanned hand is pinned to the bottom of the screen, centered under the board.
  function placeHand() {
    const sc = ui && ui.el.querySelector('.board-scroll');
    if (!sc) return;
    const r = sc.getBoundingClientRect();
    document.documentElement.style.setProperty('--hand-x', (r.left + r.width / 2) + 'px');
    document.documentElement.style.setProperty('--board-l', r.left + 'px');
    document.documentElement.style.setProperty('--board-r', (window.innerWidth - r.right) + 'px');
    // Keep the hand clear of the Energy box while it sits in its default corner.
    const fb = !ui.floatPos && window.innerWidth > 1100 ? ui.el.querySelector('.float-box') : null;
    const room = fb ? r.width - 2 * (fb.offsetWidth + 44) : r.width - 40;
    const max = Math.max(300, room);
    document.documentElement.style.setProperty('--hand-max', max + 'px');
    // Squeeze the fanned hand so it never runs past that width.
    const fan = ui.el.querySelector('.hand.fan');
    const slots = fan ? fan.querySelectorAll('.hand-cards > .slot') : [];
    if (fan && slots.length > 1) {
      const base = Number(fan.dataset.overlap || -0.22);
      const cw = slots[0].offsetWidth;
      const fit = (max - cw) / ((slots.length - 1) * cw) - 1;
      fan.style.setProperty('--overlap', String(Math.max(-0.8, Math.min(base, fit))));
    }
  }

  // ---------- turn bar ----------
  function turnInfo() {
    const s = S();
    const my = me();
    const t = Game.rampText(s);
    if (s.phase === 'mulligan') {
      const done = s.mulligan && s.mulligan[my];
      return { kind: done ? 'theirs' : 'mine', big: 'Mulligan', chip: done ? 'Mulligan · waiting' : 'Mulligan · your choice', sub: t.hint };
    }
    if (s.chain && s.chain.length) {
      const top = s.chain[s.chain.length - 1];
      const topName = def(s.cards[top.iid]).name;
      const by = top.by === my ? 'You' : Game.nameOf(s, top.by);
      const sub = `${by} ${s.chain.length > 1 ? 'responded with' : 'played'} ${topName}${top.kind === 'ability' ? "'s ability" : ''}`;
      if (s.priority === my) return { kind: 'mine', big: 'Your call', chip: `Chain · your call`, sub: `${sub}. Respond with a Reaction, or Resolve (S).` };
      const nm = Game.nameOf(s, s.priority);
      return { kind: 'theirs', big: `${nm}'s call`, chip: `Chain · ${nm}'s call`, sub: `${sub}. Waiting for ${nm} to respond or resolve.` };
    }
    if (s.phase === 'race') return { kind: 'both', big: 'Race!', chip: `Race · ${s.order.length > 2 ? 'everyone' : 'both players'}`, sub: t.hint };
    if (s.step >= Game.CHECK(s)) {
      const f = s.fight || {};
      if (f.result === 'fight') return { kind: 'both', big: 'Fight!', chip: 'Mini-lane fight', sub: 'Both chose to fight. Fight it out in the mini lanes, then press Continue.' };
      if (f.result) return { kind: 'both', big: 'No fight', chip: 'Fight check · done', sub: 'Someone refused. Press Continue to move on.' };
      return { kind: 'both', big: 'Fight?', chip: `Fight check · ${s.order.length > 2 ? 'everyone' : 'both players'}`, sub: t.hint };
    }
    if (t.who === my) return { kind: 'mine', big: 'Your turn', chip: `Your turn · ${t.short}`, sub: t.hint };
    const nm = Game.nameOf(s, t.who);
    return { kind: 'theirs', big: `${nm}'s turn`, chip: `${nm}'s turn · ${t.short}`, sub: t.hint };
  }

  function hudEl() {
    const s = S();
    const my = me();
    const op = Game.opp(s, my);
    const info = turnInfo();
    const { segs, index, turns } = Game.phaseTrack(s);
    const startPos = ui.lastPos !== undefined ? ui.lastPos : index;

    const player = (pid, side) => {
      const p = s.players[pid];
      return h('div', { class: 'hud-player ' + side },
        h('span', { class: 'hud-name' }, p.name),
        h('span', { class: 'hud-fans' }, h('strong', null, p.fans), ` / ${Game.winTarget(s)} fans`),
        side === 'opp' ? h('span', { class: 'hud-hand' }, `${(s.zones[pid + ':hand'] || []).length} in hand · ${(s.zones[pid + ':deck'] || []).length} in deck`) : null,
        h('span', { class: 'hud-meter' }, h('span', { style: { width: Math.max(0, Math.min(100, (p.fans / Game.winTarget(s)) * 100)) + '%' } })));
    };

    // group labels (Ramp 1, Ramp 2, End, Race) span their segments
    const groups = [];
    segs.forEach(sg => {
      const last = groups[groups.length - 1];
      if (last && last.name === sg.group) last.n++;
      else groups.push({ name: sg.group, n: 1 });
    });
    const multiTrack = s.order.length > 2;
    const track = h('div', { class: 'track' + (multiTrack ? ' multi' : ''), style: { '--n': segs.length, '--pos': startPos }, 'aria-hidden': 'true' },
      (() => { let col = 1; return groups.map(g => { const el = h('span', { class: 'track-group', style: { gridColumn: `${col} / span ${g.n}` } }, g.name); col += g.n; return el; }); })(),
      segs.map((sg, i) => h('span', {
        style: { gridColumn: String(i + 1), ...(multiTrack && sg.who ? { '--pc': seatColor(sg.who) } : {}) },
        class: ['track-seg', sg.who ? (sg.who === my ? 'who-mine' : 'who-theirs') : 'who-both', sg.kind ? 'k-' + sg.kind : '', i < index ? 'done' : '', i === index ? 'now' : ''].filter(Boolean).join(' '),
        title: `${sg.group} · ${sg.label}${sg.who ? ' · ' + Game.nameOf(s, sg.who) : ''}`,
      }, multiTrack && sg.who ? `${sg.kind === 'tricks' ? '✦' : '▲'} ${sg.who === my ? 'You' : Game.nameOf(s, sg.who)}` : sg.label)),
      // Turn brackets under the track: one per Ramp, owned by its first player.
      (turns || []).map(t => h('span', {
        class: ['track-turn', t.who === my ? 'mine' : 'theirs', index >= t.start && index <= t.end && s.phase !== 'mulligan' ? 'now' : '', index > t.end ? 'done' : ''].filter(Boolean).join(' '),
        style: { gridColumn: `${t.start + 1} / ${t.end + 2}` },
        title: `Turn ${t.n}: ${Game.nameOf(s, t.who)} (until the next Units step)`,
      }, h('span', { class: 'turn-label' }, `Turn ${t.n} · ${t.who === my ? 'You' : Game.nameOf(s, t.who)}`))),
      h('span', { class: 'track-marker' }, h('i')));

    // the main action(s) for this moment
    const actions = [];
    // The chain doesn't stop the turn: Resolve sits next to the turn buttons.
    if (s.chain && s.chain.length) {
      const myCall = !s.priority || s.priority === my;
      actions.push(h('button', { class: 'btn ' + (myCall ? 'primary' : 'ghost'), disabled: !myCall, on: { click: () => act('resolve') } },
        myCall ? h('span', null, 'Resolve ', h('kbd', null, 'S')) : `Waiting for ${Game.nameOf(s, s.priority)}`));
    }
    const chainOpen = s.chain && s.chain.length;
    if (s.showdown && s.showdown.active) {
      const nm = Game.nameOf(s, s.showdown.pid);
      actions.push(h('span', { class: 'fight-note' }, 'Showdown!'));
      actions.push(h('button', { class: 'btn fight', on: { click: () => act('showdownResult', true) } }, `${s.showdown.pid === my ? 'I' : nm} won`));
      actions.push(h('button', { class: 'btn', on: { click: () => act('showdownResult', false) } }, `${s.showdown.pid === my ? 'I' : nm} failed`));
    } else if (s.showdown) {
      actions.push(h('span', { class: 'fight-note calm', title: 'Starts at the other player\'s next Units step' },
        `Showdown coming: ${s.showdown.pid === my ? 'you' : Game.nameOf(s, s.showdown.pid)}`));
    }
    if (s.phase === 'mulligan') {
      const done = s.mulligan[my];
      if (done) actions.push(h('span', { class: 'fight-note calm' }, done === 'keep' ? 'Kept · ' : 'Mulliganed · ', `waiting for ${rivalsOf(s, my).filter(p => !s.mulligan[p]).map(p => Game.nameOf(s, p)).join(', ') || 'everyone'}`));
      else actions.push(h('span', { class: 'fight-note calm' }, 'See the middle of the table'));
    } else if (s.phase === 'ramp' && s.step < Game.CHECK(s)) {
      const t = Game.rampText(s);
      actions.push(h('button', { class: 'btn ' + (t.who === my && !chainOpen ? 'primary' : 'ghost'), on: { click: () => act('nextStep') }, title: t.who === my ? 'Space' : null },
        t.who === my ? h('span', null, 'Pass ', h('kbd', null, 'Space')) : `Pass for ${Game.nameOf(s, t.who)}`));
    } else if (s.phase === 'ramp') {
      const f = s.fight || { choices: {} };
      const last = s.ramp >= Game.RAMPS();
      const next = last ? 'Begin Race →' : `Ramp ${s.ramp + 1} →`;
      if (!f.result) {
        const mine = f.choices[my];
        const rivals = rivalsOf(s, my);
        const multi = rivals.length > 1;
        const chosen = rivals.filter(p => f.choices[p]).length;
        const status = multi ? `${chosen}/${rivals.length} others have chosen` : `${Game.nameOf(s, op)} ${chosen ? 'has chosen' : 'is choosing…'}`;
        if (!mine) {
          actions.push(h('button', { class: 'btn fight', on: { click: () => act('fightChoice', 'fight') } }, 'Fight'));
          actions.push(multi
            ? h('button', { class: 'btn', title: 'If only one player chooses Fight, they get fans instead', on: { click: () => act('fightChoice', 'refuse') } }, 'Refuse')
            : h('button', { class: 'btn', title: `You lose ${G().REFUSE_FIGHT_FANS ?? 50} fans`, on: { click: () => act('fightChoice', 'refuse') } }, `Refuse (−${G().REFUSE_FIGHT_FANS ?? 50} fans)`));
          actions.push(h('span', { class: 'fight-note calm' }, status));
        } else {
          actions.push(h('span', { class: 'fight-note calm' }, `You chose ${mine === 'fight' ? 'Fight' : 'Refuse'} · ${status}`));
        }
      } else {
        if (f.result === 'fight') actions.push(h('span', { class: 'fight-note' }, f.fighters ? `Fight: ${f.fighters.map(p => p === my ? 'You' : Game.nameOf(s, p)).join(' vs ')}` : 'Mini-lane fight!'));
        actions.push(h('button', { class: 'btn primary', on: { click: () => act('continueOn') } }, next));
      }
    } else {
      actions.push(h('button', { class: 'btn primary', on: { click: () => act('endRace') } }, 'End Race →'));
    }

    return h('div', { class: 'hud turn-' + info.kind, role: 'status', 'aria-live': 'polite' },
      rivalsOf(s, my).length > 1
        ? h('div', { class: 'hud-opps' }, rivalsOf(s, my).map(pid => h('div', { class: 'hud-opp', style: { '--pc': seatColor(pid) } },
            h('span', { class: 'seat-dot' }), h('span', { class: 'hud-name' }, s.players[pid].name),
            h('strong', null, s.players[pid].fans),
            h('span', { class: 'hud-meter' }, h('span', { style: { width: Math.max(0, Math.min(100, (s.players[pid].fans / Game.winTarget(s)) * 100)) + '%' } })))))
        : player(op, 'opp'),
      h('div', { class: 'hud-center' },
        h('div', { class: 'hud-top' },
          h('span', { class: 'hud-round' }, `Round ${s.round}`),
          h('span', { class: 'turn-chip' }, h('span', { class: 'turn-dot' }), info.chip)),
        track,
        h('p', { class: 'hud-hint', title: info.sub }, info.sub)),
      player(my, 'me'),
      h('div', { class: 'hud-actions' }, actions));
  }

  // ---------- dice roll (sidebar) ----------
  function rollModal() {
    const count = h('input', { id: 'rd-n', type: 'number', min: 1, max: 10, value: ui.lastDice ? ui.lastDice.n : 1 });
    let sides = ui.lastDice ? ui.lastDice.sides : 6;
    const sideRow = h('div', { class: 'seg' });
    const drawSides = () => sideRow.replaceChildren(...[4, 6, 8, 10, 12, 20].map(n => h('button', { type: 'button', class: 'seg-btn' + (n === sides ? ' on' : ''),
      on: { click: () => { sides = n; drawSides(); } } }, 'd' + n)));
    drawSides();
    const roll = () => {
      const n = Math.max(1, Math.min(10, Number(count.value) || 1));
      ui.lastDice = { n, sides };
      const results = Array.from({ length: n }, () => 1 + (crypto.getRandomValues(new Uint32Array(1))[0] % sides));
      m.close();
      act('rollDice', sides, results);
    };
    const m = U.modal('Roll dice', h('div', { class: 'stack' },
      h('div', { class: 'row wrap' }, h('label', { for: 'rd-n' }, 'How many'), count, sideRow),
      h('p', { class: 'hint' }, 'Everyone at the table sees the roll, and it goes in the log.'),
      h('div', { class: 'row end' }, h('button', { class: 'btn primary', on: { click: roll } }, '🎲 Roll'))));
    count.focus();
  }

  function rollFx(s, r) {
    Sound.play('dice');
    const PIPS = { 1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };
    const face = (n, sides) => sides === 6
      ? h('div', { class: 'die-face' }, Array.from({ length: 9 }, (_, i) => h('i', { class: PIPS[n].includes(i + 1) ? 'on' : '' })))
      : h('div', { class: 'die-num' }, n);
    document.querySelectorAll('.roll-fx').forEach(e => e.remove());
    const dice = r.results.map(() => h('div', { class: 'die rolling' + (r.sides === 6 ? '' : ' poly') }, face(1, r.sides)));
    const total = r.results.reduce((a, b) => a + b, 0);
    const note = h('p', { class: 'dice-note' }, `${r.by === me() ? 'You' : Game.nameOf(s, r.by)} rolled ${r.results.length}d${r.sides}…`);
    const el = h('div', { class: 'roll-fx', role: 'status', on: { click: () => el.remove() } },
      h('div', { class: 'dice-card' }, h('div', { class: 'dice-row wrap' }, dice), note));
    document.body.append(el);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let k = 0;
    const tick = setInterval(() => {
      if (++k > (reduce ? 0 : 8)) {
        clearInterval(tick);
        dice.forEach((d, i) => { d.classList.remove('rolling'); d.replaceChildren(face(r.results[i], r.sides)); });
        note.textContent = `${r.by === me() ? 'You' : Game.nameOf(s, r.by)} rolled ${r.results.join(', ')}${r.results.length > 1 ? ` · total ${total}` : ''}`;
        note.classList.add('done');
        setTimeout(() => el.remove(), 2600);
        return;
      }
      dice.forEach(d => d.replaceChildren(face(1 + Math.floor(Math.random() * r.sides), r.sides)));
    }, 90);
  }

  // ---------- the calculator (premium edition) ----------
  function calculator() {
    let shown = '0';
    const display = h('div', { class: 'calc-display', 'aria-live': 'polite' }, shown);
    const keys = ['7', '8', '9', '÷', '4', '5', '6', '×', '1', '2', '3', '−', '0', '.', '=', '+'];
    const pad = h('div', { class: 'calc-pad' }, h('button', { class: 'calc-key fn', on: { click: paywall } }, 'C'),
      h('button', { class: 'calc-key fn', on: { click: paywall } }, '±'), h('button', { class: 'calc-key fn', on: { click: paywall } }, '%'),
      h('button', { class: 'calc-key fn', on: { click: paywall } }, '√'),
      keys.map(k => h('button', { class: 'calc-key' + (k === '=' ? ' eq' : /[÷×−+]/.test(k) ? ' op' : ''), on: { click: paywall } }, k)));
    U.modal('Calculator', h('div', { class: 'calc' }, display, pad), { onClose: () => document.querySelectorAll('.paywall').forEach(e => e.remove()) });
  }

  // A totally real, definitely not fake subscription screen.
  function paywall() {
    ui.paywalls = (ui.paywalls || 0) + 1;
    const n = ui.paywalls;
    const price = x => '$' + (x * Math.pow(3.7, n - 1)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    document.querySelectorAll('.paywall').forEach(e => e.remove());
    const no = [`No thanks, I'll count on my fingers`, 'I can do math myself, actually', 'Please, I just want to add two numbers', 'Fine. Fingers it is.'][Math.min(3, n - 1)];
    const plan = (name, cost, per, perks, hot) => h('div', { class: 'pw-plan' + (hot ? ' hot' : '') },
      hot ? h('span', { class: 'pw-tag' }, 'Most popular') : null,
      h('strong', null, name), h('div', { class: 'pw-price' }, cost, h('small', null, per)),
      h('ul', null, perks.map(p => h('li', null, p))),
      h('button', { class: 'btn ' + (hot ? 'primary' : ''), on: { click: e => {
        e.currentTarget.textContent = ['Declined: Stars are not legal tender', 'Error 402: Not enough fans', 'Card declined (it was an Uma card)', 'Payment failed: try exhausting more Stars'][Math.floor(Math.random() * 4)];
        e.currentTarget.disabled = true;
      } } }, 'Subscribe'));
    const el = h('div', { class: 'paywall', role: 'dialog', 'aria-label': 'Upgrade to Calculator Pro' },
      h('div', { class: 'pw-card' },
        h('p', { class: 'pw-eyebrow' }, n > 1 ? `Attempt #${n} · prices adjusted for demand` : 'Premium feature'),
        h('h2', null, 'Uma Calc ', h('span', null, 'PRO™')),
        h('p', { class: 'muted' }, n > 1 ? 'Still trying to press buttons? Bold. Our pricing has been updated to reflect your enthusiasm.' : 'Pressing calculator buttons is a premium feature. Choose a plan to unlock arithmetic.'),
        h('div', { class: 'pw-plans' },
          plan('Addition Pass', price(299.99), '/month', ['The + key', 'Up to 3 additions per Race', 'Email support (we read it eventually)']),
          plan('Equals Unlimited', price(1499.99), '/week', ['The = key, unlimited', 'All four operations', 'Decimal point (beta)', 'A tiny gold star sticker'], true),
          plan('Superhorse Math', price(9999.99), '/day', ['Everything above', 'Square roots of your enemies', 'Priority counting', 'One (1) motivational neigh'])),
        h('button', { class: 'linkish pw-no', on: { click: () => el.remove() } }, no),
        h('p', { class: 'pw-fine' }, 'Prices do not include tax, tips, or emotional damage. This is a joke. Nothing is for sale.')));
    document.body.append(el);
  }

  // Dice roll for who goes first: both dice tumble, ties roll again.
  function diceFx(s, opts = {}) {
    Sound.play('dice');
    const PIPS = { 1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };
    const face = n => h('div', { class: 'die-face' }, Array.from({ length: 9 }, (_, i) => h('i', { class: PIPS[n].includes(i + 1) ? 'on' : '' })));
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const dieBox = pid => {
      const box = h('div', { class: 'die-slot' + (pid === me() ? ' mine' : '') },
        h('div', { class: 'die' }, face(1)),
        h('span', { class: 'die-name' }, pid === me() ? 'You' : Game.nameOf(s, pid)));
      return box;
    };
    const boxes = s.order.map(dieBox);
    const note = h('p', { class: 'dice-note' }, 'Rolling for who goes first…');
    const row = [];
    boxes.forEach((b, i) => { if (i) row.push(h('span', { class: 'dice-vs' }, 'vs')); row.push(b); });
    const el = h('div', { class: 'dice-fx' + (opts.drop ? ' drop' : ''), role: 'status', on: { click: () => el.remove() } },
      h('div', { class: 'dice-card' }, h('p', { class: 'eyebrow' }, 'Who goes first?'), h('div', { class: 'dice-row wrap' }, row), note));
    document.body.append(el);
    const setDie = (box, n, rolling) => {
      const d = box.querySelector('.die');
      d.replaceChildren(face(n));
      d.classList.toggle('rolling', rolling);
    };
    const rolls = s.dice.rolls;
    let t = 0;
    const step = reduce ? 0 : 900;
    rolls.forEach((vals, i) => {
      // tumble: flicker random faces, then land
      if (!reduce) for (let k = 0; k < 8; k++) setTimeout(() => {
        boxes.forEach(b => setDie(b, 1 + Math.floor(Math.random() * 6), true));
      }, t + k * 90);
      setTimeout(() => {
        const top = Math.max(...vals);
        const tied = vals.filter(v => v === top).length > 1;
        boxes.forEach((b, j) => { setDie(b, vals[j], false); b.classList.toggle('win', !tied && vals[j] === top); });
        note.textContent = tied ? `Tie for the highest (${top})! Rolling again…` : `${Game.nameOf(s, s.order[vals.indexOf(top)])} goes first!`;
        note.classList.toggle('done', !tied);
      }, t + step);
      t += step + (i < rolls.length - 1 ? 700 : 0);
    });
    setTimeout(() => el.remove(), t + 2400);
  }

  function showdownFx(s) {
    Sound.play('showdown');
    document.querySelectorAll('.turn-splash, .sd-fx').forEach(e => e.remove());
    const nm = s.showdown.pid === me() ? 'You go' : `${Game.nameOf(s, s.showdown.pid)} goes`;
    const el = h('div', { class: 'sd-fx', 'aria-hidden': 'true' },
      h('span', { class: 'sd-word' }, 'Showdown'),
      h('span', { class: 'sd-sub' }, `${nm} for the win · ${(s.showdown.lanes || [s.showdown.lane]).map(l => Game.LANE_LABEL[l]).join(' + ')}`));
    document.body.append(el);
    setTimeout(() => el.remove(), 2600);
  }

  // A Signature card was played: a full-screen moment for both players.
  function signatureFx(c, by) {
    if (!Sound.play('signature')) Sound.play('card_played');
    const d = def(c);
    document.querySelectorAll('.sig-fx, .turn-splash').forEach(e => e.remove());
    const types = d.types && d.types.length ? d.types : ['wit'];
    const c1 = `var(--t-${types[0]})`, c2 = `var(--t-${types[1] || types[0]})`;
    const owner = ui.defs[d.signature_of];
    const who = by === me() ? 'You' : Game.nameOf(S(), by);
    const sparks = Array.from({ length: 22 }, (_, i) => h('span', { class: 'sig-spark', style: {
      '--a': `${(i / 22) * 360 + Math.random() * 12}deg`, '--d': `${180 + Math.random() * 220}px`,
      '--t': `${0.25 + Math.random() * 0.35}s`, color: i % 2 ? c1 : c2 } }));
    const el = h('div', { class: 'sig-fx', style: { '--c1': c1, '--c2': c2 }, role: 'status', 'aria-label': `Signature card: ${d.name}` },
      h('div', { class: 'sig-veil' }),
      h('div', { class: 'sig-rays' }),
      h('div', { class: 'sig-ring' }),
      h('div', { class: 'sig-sparks' }, sparks),
      h('div', { class: 'sig-stage' },
        h('div', { class: 'sig-card' }, Cards.render(d, { size: 'l' }), h('span', { class: 'sig-sheen' })),
        h('div', { class: 'sig-text' },
          h('span', { class: 'sig-word' }, 'Signature'),
          h('span', { class: 'sig-sub' }, `${owner ? owner.name + ' · ' : ''}${who} played ${d.name}`))));
    document.body.append(el);
    setTimeout(() => el.remove(), window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 1900 : 2900);
  }

  // Big "Your turn" flash in the middle of the screen when the turn changes.
  function splash() {
    const info = turnInfo();
    // (not on top of a card's sound that just played)
    if (info.kind === 'mine' && Date.now() - (ui.cardSoundAt || 0) > 600) Sound.play('your_turn');
    document.querySelectorAll('.turn-splash').forEach(e => e.remove());
    const el = h('div', { class: 'turn-splash turn-' + info.kind, 'aria-hidden': 'true' },
      h('span', { class: 'splash-big' }, info.big),
      info.kind === 'mine' ? h('span', { class: 'splash-sub' }, S().chain && S().chain.length ? info.sub.split('.')[0] : Game.rampText(S()).short) : null);
    document.body.append(el);
    setTimeout(() => el.remove(), 1700);
  }

  function sidebarEl() {
    const s = S();
    const my = me();
    const op = Game.opp(s, my);
    const hotseat = ui.hotseat ? h('div', { class: 'hotseat' },
      h('span', { class: 'eyebrow' }, 'Viewing as'),
      h('div', { class: 'seg' }, s.order.map(pid => h('button', { class: 'seg-btn' + (pid === my ? ' on' : ''), on: { click: () => { ui.viewAs = pid; ui.prevEx = new Map(); closeMenu(); draw(); } } }, Game.nameOf(s, pid))))) : null;

    const canUndo = s.undo && s.undo.by === my;
    const chain = chainEl();
    const inspect = h('div', { class: 'inspect', id: 'inspect', hidden: !!chain });
    drawInspect(inspect);

    return h('aside', { class: 'sidebar' },
      hotseat,
      chain,
      inspect,
      h('section', { class: 'controls' },
        h('div', { class: 'grid-btns' },
          h('button', { class: 'btn', on: { click: () => act('draw', 1) } }, 'Draw 1'),
          h('button', { class: 'btn', on: { click: () => act('channel', G().STARS_PER_RAMP) } }, `Channel ${G().STARS_PER_RAMP}`),
          h('button', { class: 'btn', on: { click: () => act('readyAll') } }, 'Ready all'),
          h('button', { class: 'btn', on: { click: () => act('revealHand') } }, s.players[my].revealHand ? 'Hide hand' : 'Reveal hand'),
          h('button', { class: 'btn', on: { click: conjureModal } }, 'Conjure…'),
          h('button', { class: 'btn', on: { click: tokenModal } }, 'Token…'),
          h('button', { class: 'btn', on: { click: () => act('shuffleDeck') } }, 'Shuffle deck'),
          h('button', { class: 'btn', on: { click: rollModal } }, '🎲 Roll dice…'),
          h('button', { class: 'btn', on: { click: calculator } }, '🧮 Calculator'),
          h('button', { class: 'btn ghost', disabled: !s.arrows.some(a => a.by === my), on: { click: () => act('clearArrows') } }, 'Clear my arrows'),
          h('button', { class: 'btn ghost', disabled: !canUndo, title: canUndo ? 'Undo your last action' : 'Only your own last action can be undone', on: { click: () => act('undo') } }, 'Undo')),
        effectsBox(),
        h('details', { class: 'keys-box' }, h('summary', null, 'Mouse & keyboard'), h('dl', { class: 'keys' },
          h('dt', null, 'Left-click'), h('dd', null, 'exhaust / ready your card · ping theirs'),
          h('dt', null, 'Right-click'), h('dd', null, 'all options (long-press on touch). Your Stars: recycle'),
          h('dt', null, 'Space'), h('dd', null, 'pass your step'),
          h('dt', null, 'Deck'), h('dd', null, 'click to draw · right-click to shuffle or search'),
          h('dt', null, 'Drag'), h('dd', null, 'move cards between zones')))),
      h('section', { class: 'log' },
        h('h3', null, 'Table log'),
        h('ol', { class: 'log-list', id: 'log-list' }, [...s.log].reverse().slice(0, 40).map(e => h('li', { class: e.by === my ? 'mine' : (e.by ? 'theirs' : 'sys') },
          e.by ? h('strong', null, Game.nameOf(s, e.by) + ' ') : null, e.text)))),
      h('div', { class: 'row between' },
        h('button', { class: 'btn ghost sm', on: { click: () => { leave(); App.go('play'); } } }, '← Lobby'),
        !s.winner ? h('button', { class: 'btn ghost sm danger', on: { click: async () => { if (await U.ask('Concede this match?', 'Concede', true)) act('concede'); } } }, 'Concede') : null));
  }

  // Animation settings (just for this browser).
  function effectsBox() {
    const p = Anim.prefs();
    const cb = (key, label) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!p[key],
      on: { change: e => { p[key] = e.target.checked; Anim.setPrefs(p); } } }), label);
    return h('details', { class: 'keys-box' }, h('summary', null, 'Effects'),
      h('div', { class: 'stack tight fx-prefs' }, cb('on', 'Play card animations'), cb('code', 'Allow custom-code animations'),
        soundPrefs(),
        h('p', { class: 'hint' }, 'Only changes what you see and hear on this computer.')));
  }

  // Sound on/off and volume (just for this browser).
  function soundPrefs() {
    const sp = Sound.prefs();
    const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: sp.volume, 'aria-label': 'Sound volume', disabled: !sp.on,
      on: { change: e => { sp.volume = Number(e.target.value); Sound.setPrefs(sp); Sound.play('your_turn'); } } });
    return h('div', { class: 'stack tight' },
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!sp.on,
        on: { change: e => { sp.on = e.target.checked; Sound.setPrefs(sp); vol.disabled = !sp.on; if (!sp.on) Sound.stopAll(); } } }), 'Play sounds'),
      h('label', { class: 'snd-vol' }, h('span', { class: 'muted' }, 'Volume'), vol));
  }

  // ---------- the chain panel ----------
  function chainEl() {
    const s = S();
    const my = me();
    if (!s.chain || !s.chain.length) return null;
    const top = s.chain[s.chain.length - 1];
    const myCall = !s.priority || s.priority === my;
    const caller = s.priority ? Game.nameOf(s, s.priority) : '';
    const isNew = it => !ui.seenChain.has(it.n);
    const who = it => (it.by === my ? 'You' : Game.nameOf(s, it.by));
    const cardOf = (it, size) => {
      const c = s.cards[it.iid];
      if (!c) return h('div');
      const d = def(c);
      return d.card_type === 'star' ? Cards.renderStar(d.types[0], size === 'l' ? 'm' : 's') : Cards.render(d, { size });
    };
    const menuFor = it => e => {
      e.preventDefault(); e.stopPropagation();
      if (ui.pick && s.cards[it.iid]) { finishPick(s.cards[it.iid]); return; }
      chainMenu(it, e.currentTarget);
    };
    return h('section', { class: 'chain-box' + (myCall ? ' my-call' : '') },
      h('div', { class: 'chain-head' },
        h('h3', null, `Chain · ${s.chain.length}`),
        h('span', { class: 'pill' + (myCall ? ' live' : '') }, myCall ? 'Your call' : `${caller}'s call`)),
      h('p', { class: 'hint' }, myCall
        ? 'Respond with a Reaction from your hand (it goes on top), or resolve the top card.'
        : `Waiting for ${caller} to respond or resolve.`),
      h('button', { class: 'btn primary chain-resolve', disabled: !myCall, on: { click: () => act('resolve') } }, 'Resolve top ', h('kbd', null, 'S')),
      h('div', { class: 'chain-top ' + (top.by === my ? 'mine' : 'theirs') + (isNew(top) ? ' enter' : ''), title: 'Click for options', dataset: { chainIid: top.iid }, on: { click: menuFor(top), contextmenu: menuFor(top) } },
        h('span', { class: 'chain-tag' }, top.kind === 'ability' ? 'Ability · resolves first' : 'Resolves first'),
        cardOf(top, 'l'),
        h('span', { class: 'chain-who' }, `${who(top)} · ${Game.chainDestText(s, top)}`)),
      s.chain.length > 1 ? h('ol', { class: 'chain-list', 'aria-label': 'Rest of the chain, next to resolve first' },
        s.chain.slice(0, -1).reverse().map((it, i) => h('li', {
          class: (it.by === my ? 'mine' : 'theirs') + (isNew(it) ? ' enter' : ''), title: 'Click for options', dataset: { chainIid: it.iid },
          on: { click: menuFor(it), contextmenu: menuFor(it) },
        },
          h('span', { class: 'chain-num' }, i + 2),
          cardOf(it, 's'),
          h('span', { class: 'chain-li-text' },
            h('strong', null, def(s.cards[it.iid]).name + (it.kind === 'ability' ? ' (ability)' : '')),
            h('small', null, `${who(it)} · ${Game.chainDestText(s, it)}`))))) : null);
  }

  function chainMenu(it, anchor) {
    const s = S();
    const top = s.chain[s.chain.length - 1];
    const items = [];
    if (it.by === me() && it.n === top.n) items.push({ label: 'Take it back', fn: () => act('takeBack', it.n) });
    items.push({ label: it.kind === 'ability' ? 'Counter this ability' : 'Counter (send to trash)', fn: () => act('counter', it.n), cls: 'danger' });
    if (it.n === top.n && s.priority && s.priority !== me()) items.push({ label: `Resolve anyway (skip ${Game.nameOf(s, s.priority)}'s call)`, fn: () => act('resolve', true) });
    if (it.by === me()) items.push({ label: 'Target a card… (arrow)', fn: () => { ui.pick = { kind: 'target', iid: it.iid }; draw(); } });
    items.push({ label: 'Banish (out of the game)', fn: () => act('banish', it.iid), cls: 'danger' });
    openMenu(s.cards[it.iid], anchor, items);
  }

  // Big version of a card, shown right next to the one under the mouse.
  function showPeek(c, el) {
    hidePeek();
    if (!window.matchMedia('(hover: hover)').matches || ui.menu) return;
    const d = def(c);
    if (d.card_type === 'star') return;
    const notes = [];
    if (c.might) notes.push(`Might ${c.might > 0 ? '+' : ''}${c.might} (now ${Number(d.might || 0) + c.might})`);
    if (c.tmp) notes.push(`Temp might ${c.tmp > 0 ? '+' : ''}${c.tmp}`);
    if (c.dmg) notes.push(`${c.dmg} damage`);
    if (Game.shownExhausted(c, me())) notes.push('Exhausted');
    if (c.faceDown) notes.push('Face-down');
    const peek = h('div', { class: 'peek', 'aria-hidden': 'true' },
      Cards.render(d, { size: 'l' }),
      notes.length ? h('span', { class: 'peek-note' }, notes.join(' · ')) : null);
    document.body.append(peek);
    const r = el.getBoundingClientRect();
    const pw = peek.offsetWidth, ph = peek.offsetHeight;
    let left = r.right + 12;
    if (left + pw > window.innerWidth - 8) left = r.left - pw - 12;
    if (left < 8) left = Math.min(window.innerWidth - pw - 8, Math.max(8, r.left + r.width / 2 - pw / 2));
    const top = Math.max(8, Math.min(window.innerHeight - ph - 8, r.top + r.height / 2 - ph / 2));
    peek.style.left = left + 'px';
    peek.style.top = top + 'px';
    ui.peek = peek;
  }
  function hidePeek() {
    document.querySelectorAll('.peek').forEach(p => p.remove());
    if (ui) ui.peek = null;
  }

  function showInspect(c) {
    ui.inspect = c.iid;
    const el = document.getElementById('inspect');
    if (el) drawInspect(el);
  }

  function drawInspect(el) {
    const s = S();
    const c = ui.inspect && s.cards[ui.inspect];
    if (!c || (Game.isHidden(s, c, me()) && !(c.faceDown && c.owner === me()))) {
      el.replaceChildren(h('p', { class: 'muted' }, 'Hover or click a card to read it here.'));
      return;
    }
    const d = def(c);
    el.replaceChildren(...[
      d.card_type === 'star' ? Cards.renderStar(d.types[0], 'm') : Cards.render(d, { size: 'l' }),
      c.dmg || c.might || c.tmp ? h('p', { class: 'hint' }, [c.might ? `Might ${c.might > 0 ? '+' : ''}${c.might}` : '', c.tmp ? `Temp might ${c.tmp > 0 ? '+' : ''}${c.tmp}` : '', c.dmg ? `${c.dmg} damage` : ''].filter(Boolean).join(' · ')) : null,
      codeRulesEl(d)].filter(Boolean));
  }

  // A card's code, in plain English (for the inspect panel).
  function codeRulesEl(d) {
    const rules = Game.rulesFor(ui.defs, { def: d.id });
    if (!rules.length) return null;
    return h('div', { class: 'code-rules' }, h('p', { class: 'eyebrow' }, '✦ Card code'),
      h('ul', null, rules.map(r => h('li', null, CardCode.explain(r)))));
  }

  // ---------- arrows ----------
  function drawArrows() {
    if (!ui) return;
    const svg = document.getElementById('arrows');
    const board = document.getElementById('board');
    if (!svg || !board) return;
    const s = S();
    const br = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    svg.setAttribute('viewBox', `0 0 ${br.width} ${br.height}`);
    svg.setAttribute('width', br.width);
    svg.setAttribute('height', br.height);
    // Cards on the table first, then cards on the chain.
    const find = iid => board.querySelector(`[data-iid="${iid}"]`) || ui.el.querySelector(`[data-chain-iid="${iid}"] .card, [data-chain-iid="${iid}"]`);
    const ns = 'http://www.w3.org/2000/svg';
    svg.replaceChildren();
    const defsEl = document.createElementNS(ns, 'defs');
    for (const id of ['mine', 'theirs']) {
      const mk = document.createElementNS(ns, 'marker');
      mk.setAttribute('id', 'head-' + id);
      mk.setAttribute('viewBox', '0 0 10 10');
      mk.setAttribute('refX', '8'); mk.setAttribute('refY', '5');
      mk.setAttribute('markerWidth', '6'); mk.setAttribute('markerHeight', '6');
      mk.setAttribute('orient', 'auto-start-reverse');
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('d', 'M0,0 L10,5 L0,10 z');
      p.setAttribute('class', 'arrow-head ' + id);
      mk.append(p);
      defsEl.append(mk);
    }
    svg.append(defsEl);
    for (const a of s.arrows || []) {
      const f = find(a.from);
      const t = find(a.to);
      if (!f || !t) continue;
      const fr = f.getBoundingClientRect(), tr = t.getBoundingClientRect();
      const x1 = fr.left + fr.width / 2 - br.left, y1 = fr.top + fr.height / 2 - br.top;
      const x2 = tr.left + tr.width / 2 - br.left, y2 = tr.top + tr.height / 2 - br.top;
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2 - Math.min(80, Math.abs(x2 - x1) / 3 + 30);
      const path = document.createElementNS(ns, 'path');
      const who = a.by === me() ? 'mine' : 'theirs';
      path.setAttribute('d', `M${x1},${y1} Q${mx},${my} ${x2},${y2}`);
      path.setAttribute('class', 'arrow-line ' + who);
      path.setAttribute('marker-end', `url(#head-${who})`);
      svg.append(path);
    }
  }

  return { open, leave };
})();
