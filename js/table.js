// The game table: draws the match and turns clicks into actions.
window.Table = (() => {
  const { h } = U;
  const G = () => window.CONFIG.GAME;

  let ui = null;

  async function open(el, matchId) {
    el.replaceChildren(h('p', { class: 'muted pad' }, 'Loading the table…'));
    let m;
    try { m = await App.backend.getMatch(matchId); } catch (e) { el.replaceChildren(h('p', { class: 'form-error pad' }, e.message)); return; }
    const isPlayer = [m.p1, m.p2].includes(App.me.id);
    // Matches started before tokens existed still get them.
    for (const t of Cards.TOKENS) if (!m.defs[t.id]) m.defs[t.id] = t;
    if (!m.state.ramp) m.state.ramp = 1;
    ui = {
      el, id: matchId, defs: m.defs, row: m, viewAs: isPlayer ? App.me.id : m.p1,
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
      if (e.key === 'Escape') { closeMenu(); if (ui.pick) { ui.pick = null; draw(); } return; }
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
  }

  const me = () => ui.viewAs;
  const S = () => ui.row.state;
  const def = c => ui.defs[c.def] || { name: 'Unknown card', card_type: 'uma', types: ['speed'] };

  // Shows the result instantly, then saves it to the server in the background.
  // If the server disagrees (e.g. the other player acted at the same moment),
  // the table snaps to the server's version once everything is saved.
  function act(name, ...args) {
    closeMenu();
    if (!ui) return;
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
    if (s.chain && s.chain.length) { U.toast('Resolve the chain first (S).'); return; }
    if (s.phase === 'ramp' && s.step < 3) {
      const t = Game.rampText(s);
      if (t.who === me()) act('nextStep');
      else U.toast(`It's ${Game.nameOf(s, t.who)}'s step. Use the Pass button to pass for them.`);
    } else {
      U.toast(s.phase === 'race' ? 'Use End Race in the sidebar when the Race is done.' : 'Use the sidebar to fight or begin the Race.');
    }
  }

  // ---------- drawing ----------
  function draw() {
    if (!ui) return;
    hidePeek();
    ui.anims = [];
    const s = S();
    const my = me();
    const op = Game.opp(s, my);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'arrows');
    svg.setAttribute('id', 'arrows');
    svg.setAttribute('aria-hidden', 'true');
    const board = h('div', { class: 'board' + (s.phase === 'race' ? ' racing' : ''), id: 'board' },
      sideEl(op, true),
      lanesEl(),
      sideEl(my, false),
      svg);
    const old = { x: (ui.el.querySelector('.board-scroll') || {}).scrollLeft || 0,
      side: (ui.el.querySelector('.sidebar') || {}).scrollTop || 0,
      log: (ui.el.querySelector('.log-list') || {}).scrollTop || 0 };
    board.addEventListener('contextmenu', e => e.preventDefault());
    const hud = hudEl();
    const wrap = h('div', { class: 'table' + (ui.pick ? ' picking' : '') },
      hud,
      h('div', { class: 'board-scroll' }, board),
      sidebarEl());
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
    for (const c of Object.values(s.cards)) ui.prevEx.set(c.iid, c.exhausted);
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
    if (!s.winner && ((ui.turnKey && ui.turnKey !== turnKey) || (callKey && ui.callKey !== callKey && ui.turnKey))) splash();
    ui.turnKey = turnKey;
    ui.callKey = callKey;
    if (ui.pick) {
      ui.el.prepend(h('div', { class: 'pick-banner', role: 'status' },
        ui.pick.kind === 'target' ? 'Click the card to point at.' : 'Click the card to attach to.',
        h('button', { class: 'btn ghost sm', on: { click: () => { ui.pick = null; draw(); } } }, 'Cancel (Esc)')));
    }
    if (s.winner) ui.el.append(winnerEl());
    requestAnimationFrame(drawArrows);
    // mark pings as seen after they've animated once
    for (const p of s.pings || []) ui.seenPings.add(p.n);
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

  function sideEl(pid, isOpp) {
    const s = S();
    const p = s.players[pid];
    const key = z => `${pid}:${z}`;
    const deckN = (s.zones[key('deck')] || []).length;
    const starsN = (s.zones[key('stars')] || []).length;
    const trash = zoneCards(key('trash'));
    const hand = zoneCards(key('hand'));
    const mine = pid === me();

    const fans = h('div', { class: 'fans' + (mine ? ' mine' : '') },
      h('div', { class: 'fans-name' }, p.name, p.revealHand ? h('span', { class: 'pill' }, 'Hand revealed') : null),
      h('div', { class: 'fans-num' }, h('span', { class: 'n' }, p.fans), h('span', { class: 'of' }, 'fans')),
      h('div', { class: 'fans-btns' },
        [-10, 10, G().MINI_LANE_FANS, G().RACE_FANS].map(d => h('button', { class: 'chip-btn', on: { click: () => act('fans', pid, d) } }, (d > 0 ? '+' : '') + d))));

    const piles = h('div', { class: 'piles' },
      pileEl('Deck', deckN, mine ? { click: () => act('draw', 1), context: () => deckMenu(pid), title: 'Click: draw 1 · Right-click: shuffle or search' } : null, 'deck-top', pid),
      pileEl('Stars', starsN, mine ? { click: () => act('channel', 1), title: 'Click: channel 1 Star' } : null, null, pid),
      pileEl('Trash', trash.length, { click: () => trashModal(pid), context: () => trashModal(pid), title: 'Click: look at the trash' }, 'trash', pid, trash.length ? trash[trash.length - 1] : null));

    const leader = zoneEl(key('leader'), 'leader', 'Leader', pid);
    const base = zoneEl(key('base'), 'base', 'Base', pid);
    const pool = zoneEl(key('pool'), 'pool', 'Star pool', pid, true);

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
      class: 'hand' + (mine ? ' mine fan' : ''), dataset: mine ? { drop: 'hand', owner: pid } : {},
      style: mine ? { '--overlap': n > 9 ? '-0.5' : n > 6 ? '-0.38' : '-0.22' } : null,
    },
      h('span', { class: 'zone-label' }, `Hand · ${hand.length}`),
      h('div', { class: 'hand-cards' }, handCards));
    bindDrop(handEl, pid);

    // The other player's hand only takes a row when it's revealed; otherwise
    // its size is shown in the turn bar, to keep the board on one screen.
    return h('div', { class: 'side ' + (isOpp ? 'opp' : 'me') },
      isOpp && p.revealHand ? handEl : null,
      h('div', { class: 'side-row' }, fans, leader, base, pool, piles),
      isOpp ? null : handEl);
  }

  function pileEl(label, n, handlers, drop, pid, topCard) {
    const face = topCard && !Game.isHidden(S(), topCard, me()) ? Cards.render(def(topCard), { size: 's', title: false }) : (n ? Cards.renderBack('s') : h('div', { class: 'pile-empty' }));
    const on = {};
    if (handlers && handlers.click) on.click = handlers.click;
    if (handlers && handlers.context) on.contextmenu = e => { e.preventDefault(); handlers.context(); };
    const el = h(handlers ? 'button' : 'div', { class: 'pile', title: handlers ? handlers.title : null, on, dataset: drop ? { drop, owner: pid } : {} },
      face,
      h('span', { class: 'pile-label' }, `${label} · ${n}`));
    if (drop) bindDrop(el, pid);
    return el;
  }

  function zoneEl(key, dest, label, pid, stars = false) {
    const cards = zoneCards(key).filter(c => !c.attachedTo || !S().cards[c.attachedTo] || S().cards[c.attachedTo].zone !== key);
    const el = h('div', { class: `zone zone-${dest}`, dataset: { drop: dest, owner: pid || '' } },
      h('span', { class: 'zone-label' }, label),
      h('div', { class: 'zone-cards' + (stars ? ' stars' : '') }, cards.map(c => cardEl(c))));
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
        const opMight = all.filter(c => c.owner === op).reduce((a, c) => a + mightOf(c), 0);
        const myMight = all.filter(c => c.owner === my).reduce((a, c) => a + mightOf(c), 0);
        // environment slot(s): one per mini lane; the Race lane shows both
        const slots = l === 'race' ? Game.ENV_SLOTS : ['env:' + l];
        const tint = {};
        const envEls = slots.map((k, i) => {
          const env = zoneCards(k)[0];
          if (env) tint[i ? '--env2' : '--env1'] = `var(--t-${(def(env).types || ['wit'])[0]})`;
          const box = h('div', { class: `lane-env ${i ? 'right' : 'left'}${env ? ' filled' : ''}`, dataset: { drop: k },
            title: env ? null : `Drop an Environment here (${Game.ENV_LABEL[k]})` },
            h('span', { class: 'env-label' }, l === 'race' ? `Env · ${i ? 'Lane 2' : 'Lane 1'}` : 'Environment'),
            env ? cardEl(env) : h('div', { class: 'env-empty', 'aria-hidden': 'true' }, '☁'));
          bindDrop(box, null);
          return box;
        });
        const el = h('div', { class: 'lane lane-' + l + (Object.keys(tint).length ? ' has-env' : ''), dataset: { drop: l }, style: tint },
          h('div', { class: 'lane-head' }, h('span', { class: 'lane-name' }, Game.LANE_LABEL[l]),
            h('span', { class: 'lane-might', title: 'Total might (face-up units)' }, `${opMight} vs ${myMight}`)),
          envEls,
          h('div', { class: 'lane-half opp' }, all.filter(c => c.owner === op).map(c => cardEl(c))),
          h('div', { class: 'lane-rail', 'aria-hidden': 'true' }),
          h('div', { class: 'lane-half me' }, all.filter(c => c.owner === my).map(c => cardEl(c))));
        bindDrop(el, null);
        return el;
      }));
  }

  function mightOf(c) {
    if (c.faceDown && c.owner !== me()) return 0;
    const d = def(c);
    if (!Cards.hasMight(d)) return c.might || 0;
    return Number(d.might) + (c.might || 0);
  }

  function cardEl(c) {
    const s = S();
    const hidden = Game.isHidden(s, c, me());
    const d = def(c);
    const kind = Game.zoneKind(c.zone);
    let face;
    if (hidden) face = Cards.renderBack('s');
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
    }
    const newPing = (s.pings || []).some(p => p.iid === c.iid && !ui.seenPings.has(p.n));
    const canDrag = canMove(c);
    const kids = Game.attachmentsOf(s, c.iid).map(k => s.cards[k]).filter(k => k.zone === c.zone);
    const prevEx = ui.prevEx.get(c.iid);
    const animate = prevEx !== undefined && prevEx !== c.exhausted && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const shownEx = animate ? prevEx : c.exhausted;
    const slot = h('div', {
      class: ['slot', shownEx ? 'ex' : '', c.faceDown ? 'fd' : '', newPing ? 'pinged' : '',
        ui.pick && ui.pick.iid === c.iid ? 'picking-src' : '', d.card_type === 'star' ? 'is-star' : ''].filter(Boolean).join(' '),
      dataset: { iid: c.iid },
      draggable: canDrag ? 'true' : null,
      tabindex: '0',
      role: 'button',
      'aria-label': hidden ? 'Hidden card' : `${d.name}${c.exhausted ? ', exhausted' : ''}${c.dmg ? ', ' + c.dmg + ' damage' : ''}`,
      on: {
        click: e => {
          e.stopPropagation();
          if (ui.suppressClick) { ui.suppressClick = false; return; }
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
      c.faceDown && !hidden ? h('span', { class: 'tag' }, 'Face-down') : null,
      c.conjured && !hidden ? h('span', { class: 'tag conj' }, 'Conjured') : null,
      kids.length ? h('div', { class: 'attached' }, kids.map(k => cardEl(k))) : null);
    if (animate) ui.anims.push({ el: slot, to: c.exhausted });
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
      if (dest === 'pool' && def(c).card_type !== 'star') return U.toast('Only Stars go in the Star pool.', 'error');
      if (dest !== 'pool' && def(c).card_type === 'star' && dest !== 'trash') return U.toast('Stars stay in the Star pool. Use Recycle to send one back.', 'error');
      if (el.dataset.owner && el.dataset.owner !== c.owner && ['base', 'hand', 'trash', 'deck-top'].includes(dest)) {
        return U.toast("Cards go to their owner's zones. Use Give to hand a card over.", 'error');
      }
      if (c.zone === (Game.LANES.includes(dest) ? 'lane:' + dest : `${c.owner}:${dest}`)) return;
      // From your hand onto the table = playing it (goes on the chain).
      const fromHand = Game.zoneKind(c.zone) === 'hand' && c.owner === me();
      const isEnv = Cards.isEnvironment(def(c));
      if (Game.ENV_SLOTS.includes(dest) && !isEnv) return U.toast('Only Environment cards go in the environment slot.', 'error');
      // An environment dropped on a mini lane goes into that lane's environment slot.
      if (isEnv && fromHand && (dest === 'mini0' || dest === 'mini1')) act('play', iid, 'env:' + dest);
      else if (fromHand && (Game.ENV_SLOTS.includes(dest) || (Game.BOARD.includes(dest) && dest !== 'pool'))) act('play', iid, dest);
      else act('move', iid, dest);
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
    if (kind === 'hand') { openMenu(c, anchor); return; }
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

    if (kind === 'hand') {
      if (!mine) return [{ label: 'This is in their hand.', fn: null }];
      const isTrick = d.card_type === 'trick';
      if (Cards.isEnvironment(d)) {
        for (const k of Game.ENV_SLOTS) {
          const cur = zoneCards(k)[0];
          it(`Set environment: ${Game.ENV_LABEL[k]}${cur ? ` (replaces ${def(cur).name})` : ''}`, () => act('play', c.iid, k), 'env');
        }
        sep();
      }
      if (isTrick) it('Cast (to the chain)', () => act('play', c.iid, 'trash'));
      it('Play to base', () => act('play', c.iid, 'base'));
      it('Play to Mini lane 1', () => act('play', c.iid, 'mini0'), 'needs-ramp');
      it('Play to Mini lane 2', () => act('play', c.iid, 'mini1'), 'needs-ramp');
      it('Play to Race lane', () => act('play', c.iid, 'race'), 'needs-race');
      it('Play face-down to a lane…', () => faceDownMenu(c));
      it('Attach to a card…', () => { ui.pick = { kind: 'attach', iid: c.iid }; draw(); });
      sep();
      if (!isTrick) it('Cast / discard (to trash)', () => act('play', c.iid, 'trash'));
      it('Top of deck', () => act('move', c.iid, 'deck-top'));
      it('Bottom of deck', () => act('move', c.iid, 'deck-bottom'));
      it('Give to opponent', () => act('give', c.iid));
      const cjh = conjureItem(c);
      if (cjh) { sep(); items.push(cjh); }
      return items.filter(x => !x || x.cls !== 'needs-ramp' && x.cls !== 'needs-race' || (x.cls === 'needs-ramp' ? s.phase === 'ramp' : s.phase === 'race'));
    }

    // on the board
    it(c.exhausted ? 'Ready' : 'Exhaust', () => act('toggleExhaust', c.iid));
    if (Cards.hasMight(d) || d.card_type === 'uma' || d.card_type === 'superhorse') {
      items.push({ counter: 'Might', minus: () => act('might', c.iid, -1), plus: () => act('might', c.iid, 1) });
    }
    items.push({ counter: 'Damage', minus: () => act('damage', c.iid, -1), plus: () => act('damage', c.iid, 1) });
    if (c.dmg || c.might) it('Clear counters', () => act('clearCounters', c.iid));
    if (!mine) it('Ping', () => act('ping', c.iid));
    if (G().USE_CHAIN !== false) it('Use ability (to the chain)', () => act('ability', c.iid));
    it('Target another card…', () => { ui.pick = { kind: 'target', iid: c.iid }; draw(); });
    const cjb = conjureItem(c);
    if (cjb) items.push(cjb);
    if (kind === 'env') {
      sep();
      const other = Game.ENV_SLOTS.find(k => k !== c.zone);
      it(`Move to ${Game.ENV_LABEL[other]}`, () => act('move', c.iid, other));
      it('Return to hand', () => act('move', c.iid, 'hand'));
      it('Trash', () => act('trash', c.iid), 'danger');
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
      it('Top of deck', () => act('move', c.iid, 'deck-top'));
      it('Trash', () => act('trash', c.iid), 'danger');
      it('Give to opponent', () => act('give', c.iid));
    }
    return items;
  }

  // ---------- Conjure ----------
  function conjureItem(c) {
    const cj = Cards.conjureOf(def(c));
    if (!cj || c.owner !== me()) return null;
    return { label: '✦ Conjure: ' + Cards.conjureSummary(cj), fn: () => doConjure(c), cls: 'conjure' };
  }

  function doConjure(c) {
    const cj = Cards.conjureOf(def(c));
    const options = Cards.conjureMatches(ui.defs, cj);
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
    const m = U.modal('Play face-down', h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'For In the Shadows cards. Your opponent sees only the card back until you reveal it.'),
      h('div', { class: 'row' }, lanes.map(l => h('button', { class: 'btn', on: { click: () => { m.close(); act('play', c.iid, l, { faceDown: true }); } } }, Game.LANE_LABEL[l])))));
  }

  function openMenu(c, anchor, custom) {
    closeMenu();
    hidePeek();
    const items = custom || menuItems(c);
    const hidden = Game.isHidden(S(), c, me()) && !(c.faceDown && c.owner === me());
    const menu = h('div', { class: 'card-menu', role: 'menu' },
      h('div', { class: 'card-menu-title' }, hidden ? 'Hidden card' : def(c).name),
      items.map(x => {
        if (!x) return h('hr');
        if (x.counter) return h('div', { class: 'counter-row' },
          h('span', null, x.counter),
          h('button', { class: 'icon-btn sm', 'aria-label': x.counter + ' minus 1', on: { click: e => { e.stopPropagation(); x.minus(); } } }, '−'),
          h('button', { class: 'icon-btn sm', 'aria-label': x.counter + ' plus 1', on: { click: e => { e.stopPropagation(); x.plus(); } } }, '+'));
        if (!x.fn) return h('div', { class: 'muted menu-note' }, x.label);
        return h('button', { class: 'menu-item' + (x.cls === 'danger' ? ' danger' : '') + (x.cls === 'conjure' ? ' conjure' : '') + (x.cls === 'env' ? ' env' : ''), role: 'menuitem', on: { click: e => { e.stopPropagation(); closeMenu(); x.fn(); } } }, x.label);
      }));
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let left = r.right + 8, top = r.top;
    if (left + mw > window.innerWidth - 8) left = Math.max(8, r.left - mw - 8);
    if (top + mh > window.innerHeight - 8) top = Math.max(8, window.innerHeight - mh - 8);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    ui.menu = menu;
    setTimeout(() => document.addEventListener('click', closeMenuOnOutside), 0);
    const first = menu.querySelector('button');
    if (first) first.focus({ preventScroll: true });
  }
  function closeMenuOnOutside(e) { if (ui && ui.menu && !ui.menu.contains(e.target)) closeMenu(); }
  function closeMenu() {
    document.removeEventListener('click', closeMenuOnOutside);
    if (ui && ui.menu) { ui.menu.remove(); ui.menu = null; }
  }

  // ---------- piles ----------
  function deckMenu(pid) {
    const m = U.modal('Your deck', h('div', { class: 'stack' },
      h('p', { class: 'muted' }, `${(S().zones[pid + ':deck'] || []).length} cards left.`),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn', on: { click: () => { m.close(); act('draw', 1); } } }, 'Draw 1'),
        h('button', { class: 'btn', on: { click: () => { m.close(); act('shuffleDeck'); } } }, 'Shuffle'),
        h('button', { class: 'btn', on: { click: () => { m.close(); searchDeck(pid); } } }, 'Look through deck…'))));
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
        h('button', { class: 'btn sm ghost', on: { click: () => { m.close(); act('move', c.iid, 'deck-bottom'); } } }, 'Bottom'))))), { wide: true });
  }

  // Trash: just the cards. Right-click (or long-press) one for its options,
  // including Conjure for spells that have already resolved.
  function trashModal(pid) {
    const s = S();
    const list = (s.zones[pid + ':trash'] || []).map(iid => s.cards[iid]).reverse();
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
      ];
      const cj = conjureItem(c);
      if (cj) items.push(null, { ...cj, fn: close(cj.fn) });
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
    m = U.modal(`${Game.nameOf(s, pid)}'s trash · ${list.length}`, [
      grid,
      list.length && mine ? h('p', { class: 'hint' }, 'Right-click a card (long-press on touch) for its options. Cards that can Conjure are marked ✦.') : null,
    ], { wide: true, onClose: () => { hidePeek(); closeMenu(); } });
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
      h('div', { class: 'token-list' }, Cards.TOKENS.map(t => h('div', { class: 'token-item' },
        Cards.render(t, { size: 'm' }),
        h('div', { class: 'stack tight' },
          h('button', { class: 'btn primary sm', on: { click: make(t.id, 'base') } }, 'To base'),
          lanes.map(l => h('button', { class: 'btn sm', on: { click: make(t.id, l) } }, 'To ' + Game.LANE_LABEL[l])))))),
      h('p', { class: 'hint' }, 'Tokens only exist in play. If one would go to your hand, deck or trash, it is removed instead.')), { wide: true });
    count.focus();
  }

  function conjureModal() {
    const defs = Object.values(ui.defs).filter(d => d.card_type !== 'star' && d.card_type !== 'superhorse' && !d.token);
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
    document.documentElement.style.setProperty('--hand-max', Math.max(300, r.width - 40) + 'px');
  }

  // ---------- turn bar ----------
  function turnInfo() {
    const s = S();
    const my = me();
    const t = Game.rampText(s);
    if (s.chain && s.chain.length) {
      const top = s.chain[s.chain.length - 1];
      const topName = def(s.cards[top.iid]).name;
      const by = top.by === my ? 'You' : Game.nameOf(s, top.by);
      const sub = `${by} ${s.chain.length > 1 ? 'responded with' : 'played'} ${topName}${top.kind === 'ability' ? "'s ability" : ''}`;
      if (s.priority === my) return { kind: 'mine', big: 'Your call', chip: `Chain · your call`, sub: `${sub}. Respond with a Reaction, or Resolve (S).` };
      const nm = Game.nameOf(s, s.priority);
      return { kind: 'theirs', big: `${nm}'s call`, chip: `Chain · ${nm}'s call`, sub: `${sub}. Waiting for ${nm} to respond or resolve.` };
    }
    if (s.phase === 'race') return { kind: 'both', big: 'Race!', chip: 'Race · both players', sub: t.hint };
    if (s.step >= 3) return { kind: 'both', big: 'End of Ramp', chip: 'End of Ramp · both players', sub: t.hint };
    if (t.who === my) return { kind: 'mine', big: 'Your turn', chip: `Your turn · ${t.short}`, sub: t.hint };
    const nm = Game.nameOf(s, t.who);
    return { kind: 'theirs', big: `${nm}'s turn`, chip: `${nm}'s turn · ${t.short}`, sub: t.hint };
  }

  function hudEl() {
    const s = S();
    const my = me();
    const op = Game.opp(s, my);
    const info = turnInfo();
    const { segs, index } = Game.phaseTrack(s);
    const startPos = ui.lastPos !== undefined ? ui.lastPos : index;

    const player = (pid, side) => {
      const p = s.players[pid];
      return h('div', { class: 'hud-player ' + side },
        h('span', { class: 'hud-name' }, p.name),
        h('span', { class: 'hud-fans' }, h('strong', null, p.fans), ` / ${G().FANS_TO_WIN} fans`),
        side === 'opp' ? h('span', { class: 'hud-hand' }, `${(s.zones[pid + ':hand'] || []).length} in hand · ${(s.zones[pid + ':deck'] || []).length} in deck`) : null,
        h('span', { class: 'hud-meter' }, h('span', { style: { width: Math.min(100, (p.fans / G().FANS_TO_WIN) * 100) + '%' } })));
    };

    // group labels (Ramp 1, Ramp 2, End, Race) span their segments
    const groups = [];
    segs.forEach(sg => {
      const last = groups[groups.length - 1];
      if (last && last.name === sg.group) last.n++;
      else groups.push({ name: sg.group, n: 1 });
    });
    const track = h('div', { class: 'track', style: { '--n': segs.length, '--pos': startPos }, 'aria-hidden': 'true' },
      groups.map(g => h('span', { class: 'track-group', style: { gridColumn: `span ${g.n}` } }, g.name)),
      segs.map((sg, i) => h('span', {
        class: ['track-seg', sg.who ? (sg.who === my ? 'who-mine' : 'who-theirs') : 'who-both', i < index ? 'done' : '', i === index ? 'now' : ''].filter(Boolean).join(' '),
        title: `${sg.group} · ${sg.label}${sg.who ? ' · ' + Game.nameOf(s, sg.who) : ''}`,
      }, sg.label)),
      h('span', { class: 'track-marker' }));

    // the main action(s) for this moment
    const actions = [];
    if (s.chain && s.chain.length) {
      const myCall = !s.priority || s.priority === my;
      actions.push(h('button', { class: 'btn ' + (myCall ? 'primary' : 'ghost'), disabled: !myCall, on: { click: () => act('resolve') } },
        myCall ? h('span', null, 'Resolve ', h('kbd', null, 'S')) : `Waiting for ${Game.nameOf(s, s.priority)}`));
    } else if (s.phase === 'ramp' && s.step < 3) {
      const t = Game.rampText(s);
      actions.push(h('button', { class: 'btn ' + (t.who === my ? 'primary' : 'ghost'), on: { click: () => act('nextStep') }, title: t.who === my ? 'Space' : null },
        t.who === my ? h('span', null, 'Pass ', h('kbd', null, 'Space')) : `Pass for ${Game.nameOf(s, t.who)}`));
    } else if (s.phase === 'ramp') {
      const agreeMe = s.players[my].agreeFight, agreeOp = s.players[op].agreeFight;
      if (s.miniFight) {
        actions.push(h('span', { class: 'fight-note' }, 'Mini-lane fight!'));
        actions.push(h('button', { class: 'btn', on: { click: () => act('endMiniFight') } }, 'End fight'));
      } else if (agreeMe && agreeOp) {
        actions.push(h('button', { class: 'btn fight', on: { click: () => act('startMiniFight') } }, 'Fight in mini lanes'));
      } else {
        actions.push(h('button', { class: 'btn' + (agreeMe ? ' on' : ''), 'aria-pressed': String(agreeMe), title: `${Game.nameOf(s, op)}: ${agreeOp ? 'agreed' : 'not yet'}`, on: { click: () => act('agreeFight') } },
          agreeMe ? '✓ Agreed to fight' : `Agree to fight${agreeOp ? ' (they agreed)' : ''}`));
      }
      actions.push(h('button', { class: 'btn primary', on: { click: () => act('startRace') } }, 'Begin Race →'));
    } else {
      actions.push(h('button', { class: 'btn primary', on: { click: () => act('endRace') } }, 'End Race →'));
    }

    return h('div', { class: 'hud turn-' + info.kind, role: 'status', 'aria-live': 'polite' },
      player(op, 'opp'),
      h('div', { class: 'hud-center' },
        h('div', { class: 'hud-top' },
          h('span', { class: 'hud-round' }, `Round ${s.round}`),
          h('span', { class: 'turn-chip' }, h('span', { class: 'turn-dot' }), info.chip)),
        track,
        h('p', { class: 'hud-hint', title: info.sub }, info.sub)),
      player(my, 'me'),
      h('div', { class: 'hud-actions' }, actions));
  }

  // Big "Your turn" flash in the middle of the screen when the turn changes.
  function splash() {
    const info = turnInfo();
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
      h('div', { class: 'seg' }, s.order.map(pid => h('button', { class: 'seg-btn' + (pid === my ? ' on' : ''), on: { click: () => { ui.viewAs = pid; closeMenu(); draw(); } } }, Game.nameOf(s, pid))))) : null;

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
          h('button', { class: 'btn ghost', disabled: !s.arrows.some(a => a.by === my), on: { click: () => act('clearArrows') } }, 'Clear my arrows'),
          h('button', { class: 'btn ghost', disabled: !canUndo, title: canUndo ? 'Undo your last action' : 'Only your own last action can be undone', on: { click: () => act('undo') } }, 'Undo')),
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
    const menuFor = it => e => { e.preventDefault(); e.stopPropagation(); chainMenu(it, e.currentTarget); };
    return h('section', { class: 'chain-box' + (myCall ? ' my-call' : '') },
      h('div', { class: 'chain-head' },
        h('h3', null, `Chain · ${s.chain.length}`),
        h('span', { class: 'pill' + (myCall ? ' live' : '') }, myCall ? 'Your call' : `${caller}'s call`)),
      h('p', { class: 'hint' }, myCall
        ? 'Respond with a Reaction from your hand (it goes on top), or resolve the top card.'
        : `Waiting for ${caller} to respond or resolve.`),
      h('button', { class: 'btn primary chain-resolve', disabled: !myCall, on: { click: () => act('resolve') } }, 'Resolve top ', h('kbd', null, 'S')),
      h('div', { class: 'chain-top ' + (top.by === my ? 'mine' : 'theirs') + (isNew(top) ? ' enter' : ''), title: 'Click for options', on: { click: menuFor(top), contextmenu: menuFor(top) } },
        h('span', { class: 'chain-tag' }, top.kind === 'ability' ? 'Ability · resolves first' : 'Resolves first'),
        cardOf(top, 'l'),
        h('span', { class: 'chain-who' }, `${who(top)} · ${Game.chainDestText(s, top)}`)),
      s.chain.length > 1 ? h('ol', { class: 'chain-list', 'aria-label': 'Rest of the chain, next to resolve first' },
        s.chain.slice(0, -1).reverse().map((it, i) => h('li', {
          class: (it.by === my ? 'mine' : 'theirs') + (isNew(it) ? ' enter' : ''), title: 'Click for options',
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
    if (c.dmg) notes.push(`${c.dmg} damage`);
    if (c.exhausted) notes.push('Exhausted');
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
      c.dmg || c.might ? h('p', { class: 'hint' }, [c.might ? `Might ${c.might > 0 ? '+' : ''}${c.might}` : '', c.dmg ? `${c.dmg} damage` : ''].filter(Boolean).join(' · ')) : null].filter(Boolean));
  }

  // ---------- arrows ----------
  function drawArrows() {
    if (!ui) return;
    const svg = document.getElementById('arrows');
    const board = document.getElementById('board');
    if (!svg || !board) return;
    const s = S();
    const br = board.getBoundingClientRect();
    svg.setAttribute('viewBox', `0 0 ${br.width} ${br.height}`);
    svg.setAttribute('width', br.width);
    svg.setAttribute('height', br.height);
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
      const f = board.querySelector(`[data-iid="${a.from}"]`);
      const t = board.querySelector(`[data-iid="${a.to}"]`);
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
