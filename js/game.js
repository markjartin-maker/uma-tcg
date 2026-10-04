// Game table rules: the match state and every manual action on it.
// The site doesn't enforce card rules — players do, like at a real table.
// It only keeps track of where everything is and what's been done.
window.Game = (() => {
  const G = () => window.CONFIG.GAME;

  const LANES = ['mini0', 'mini1', 'race'];
  const LANE_LABEL = { mini0: 'Mini lane 1', mini1: 'Mini lane 2', race: 'Race lane' };
  const BOARD = ['base', 'leader', 'pool', 'env', ...LANES]; // face-up, in play
  // Environments: one slot per mini lane ('env:mini0', 'env:mini1').
  const ENV_SLOTS = ['env:mini0', 'env:mini1'];
  const ENV_LABEL = { 'env:mini0': 'Mini lane 1', 'env:mini1': 'Mini lane 2' };
  const PLAYER_ZONES = ['deck', 'hand', 'trash', 'base', 'leader', 'champion', 'stars', 'pool', 'banish'];

  // ---------- building a match ----------

  // decks: [{owner, deck}], defs: {id: def}
  function newMatchState(players, defs) {
    const s = {
      players: {},
      order: players.map(p => p.id),
      phase: 'mulligan', // mulligan → ramp ⇄ race
      mulligan: {},      // pid → 'keep' | 'redraw'
      step: 0,
      ramp: 1,          // which Ramp of this round (1..RAMPS_PER_RACE)
      rampFirst: Math.random() < 0.5 ? 0 : 1,
      round: 1,
      cards: {},
      zones: { 'lane:mini0': [], 'lane:mini1': [], 'lane:race': [], 'shared:chain': [], 'env:mini0': [], 'env:mini1': [] },
      chain: [],        // bottom → top; the top item resolves first
      priority: null,   // who decides next while the chain is open (respond or resolve)
      chainSeq: 0,
      arrows: [],
      pings: [],
      log: [],
      winner: null,
      undo: null,
      seq: 0,
    };
    for (const p of players) {
      s.players[p.id] = { name: p.name, fans: 0, revealHand: false };
      for (const z of PLAYER_ZONES) s.zones[`${p.id}:${z}`] = [];
      const d = p.deck;
      if (d.leader_id && defs[d.leader_id]) addInstance(s, d.leader_id, p.id, `${p.id}:leader`);
      // The deck's Champion starts in its own zone, playable from there.
      if (d.champion_id && defs[d.champion_id]) s.cards[addInstance(s, d.champion_id, p.id, `${p.id}:champion`)].champion = true;
      const main = [];
      for (const [cardId, n] of Object.entries(d.cards || {})) {
        if (!defs[cardId]) continue;
        for (let i = 0; i < n; i++) main.push(addInstance(s, cardId, p.id, null));
      }
      s.zones[`${p.id}:deck`] = U.shuffle(main);
      main.forEach(iid => (s.cards[iid].zone = `${p.id}:deck`));
      const stars = [];
      for (const [type, n] of Object.entries(d.stars || {})) {
        for (let i = 0; i < n; i++) stars.push(addInstance(s, 'star:' + type, p.id, null));
      }
      s.zones[`${p.id}:stars`] = U.shuffle(stars);
      stars.forEach(iid => (s.cards[iid].zone = `${p.id}:stars`));
      for (let i = 0; i < G().STARTING_HAND; i++) drawOne(s, p.id);
    }
    const first = s.players[s.order[s.rampFirst]].name;
    log(s, null, `Match started. ${first} will play units first. Both players: keep your hand or mulligan.`);
    return s;
  }

  function addInstance(s, defId, owner, zone) {
    const iid = 'c' + (++s.seq);
    s.cards[iid] = { iid, def: defId, owner, zone, exhausted: false, might: 0, dmg: 0, faceDown: false, attachedTo: null };
    if (zone) s.zones[zone].push(iid);
    return iid;
  }

  // Everything needed to create a match after a challenge is accepted.
  async function buildMatch(backend, challenge, toDeckId) {
    const [fromDeck, toDeck, pool, profiles] = await Promise.all([
      backend.getDeck(challenge.from_deck), backend.getDeck(toDeckId), backend.listCards(), backend.listProfiles(),
    ]);
    if (!fromDeck || !toDeck) throw new Error('One of the decks no longer exists.');
    const defs = {};
    for (const c of pool) defs[c.id] = slimDef(c);
    for (const t of Cards.TYPES) defs['star:' + t.id] = Cards.starDef(t.id);
    for (const t of Cards.TOKENS) defs[t.id] = t;
    const name = id => (profiles.find(p => p.id === id) || {}).display_name || 'Player';
    const state = newMatchState([
      { id: challenge.from_user, name: name(challenge.from_user), deck: fromDeck },
      { id: challenge.to_user, name: name(challenge.to_user), deck: toDeck },
    ], defs);
    return { p1: challenge.from_user, p2: challenge.to_user, state, defs };
  }

  function slimDef(c) {
    return { id: c.id, name: c.name, card_type: c.card_type, types: c.types, energy: c.energy, power: c.power,
      might: c.might, keywords: c.keywords || [], effect: c.effect || '', image_url: c.image_url || null,
      rarity: c.rarity || 'common', full_art: !!c.full_art, subtitle: c.subtitle || null,
      tags: c.tags || [], conjure: c.conjure || null, signature_of: c.signature_of || null };
  }

  // ---------- helpers ----------

  const opp = (s, pid) => s.order.find(p => p !== pid);
  const nameOf = (s, pid) => (s.players[pid] ? s.players[pid].name : 'Someone');
  const zoneKind = z => (z.startsWith('env:') ? 'env' : z.startsWith('lane:') ? z.slice(5) : z.split(':')[1]);
  const zoneOwner = z => (z.startsWith('lane:') || z.startsWith('env:') ? null : z.split(':')[0]);

  function log(s, by, text) {
    s.log.push({ by, text, n: s.log.length ? s.log[s.log.length - 1].n + 1 : 1 });
    if (s.log.length > 80) s.log.splice(0, s.log.length - 80);
  }

  function destKey(s, c, dest) {
    if (LANES.includes(dest)) return 'lane:' + dest;
    return `${c.owner}:${dest}`;
  }

  function detachFromZone(s, iid) {
    const c = s.cards[iid];
    const arr = s.zones[c.zone];
    if (arr) {
      const i = arr.indexOf(iid);
      if (i >= 0) arr.splice(i, 1);
    }
  }

  function place(s, iid, key, pos = 'end') {
    s.zones[key] = s.zones[key] || [];
    if (pos === 'top') s.zones[key].unshift(iid);
    else s.zones[key].push(iid);
    s.cards[iid].zone = key;
  }

  function resetCard(c) {
    c.exhausted = false; c.might = 0; c.tmp = 0; c.dmg = 0; c.faceDown = false; c.attachedTo = null; c.status = [];
  }

  const attachmentsOf = (s, iid) => Object.values(s.cards).filter(c => c.attachedTo === iid).map(c => c.iid);

  // Core move. dest: base | hand | trash | deck-top | deck-bottom | mini0 | mini1 | race | pool | stars-bottom
  function moveCard(s, iid, dest, { faceDown = false, enterReady = false } = {}) {
    const c = s.cards[iid];
    const from = zoneKind(c.zone);
    const wasOnBoard = BOARD.includes(from);
    let key, pos = 'end';
    if (dest === 'deck-top') { key = `${c.owner}:deck`; pos = 'top'; }
    else if (dest === 'deck-bottom') key = `${c.owner}:deck`;
    else if (dest === 'stars-bottom') key = `${c.owner}:stars`;
    else if (ENV_SLOTS.includes(dest)) key = dest;
    else key = destKey(s, c, dest);
    const toKind = zoneKind(key);
    const toBoard = BOARD.includes(toKind);

    // Tokens only exist in play: leaving play removes them from the game.
    if (c.token && !toBoard) {
      detachFromZone(s, iid);
      for (const k of attachmentsOf(s, iid)) {
        s.cards[k].attachedTo = null;
        detachFromZone(s, k);
        place(s, k, `${s.cards[k].owner}:base`);
      }
      s.arrows = (s.arrows || []).filter(a => a.from !== iid && a.to !== iid);
      delete s.cards[iid];
      return;
    }

    detachFromZone(s, iid);
    if (c.mask && toKind !== 'pool') delete c.mask;
    const kids = attachmentsOf(s, iid);

    // A new environment replaces the one already on that lane.
    if (toKind === 'env') {
      for (const old of [...(s.zones[key] || [])]) {
        if (old === iid) continue;
        const nm = cardName(s, old, false);
        moveCard(s, old, 'trash');
        log(s, null, `${nm} was replaced and went to the trash.`);
      }
    }

    if (!toBoard) {
      resetCard(c);
      // Attached cards stay in play on their owner's base.
      for (const k of kids) {
        s.cards[k].attachedTo = null;
        detachFromZone(s, k);
        place(s, k, `${s.cards[k].owner}:base`);
      }
    } else {
      if (c.attachedTo && s.cards[c.attachedTo] && s.cards[c.attachedTo].zone !== key) c.attachedTo = null;
      const def = s.defs ? s.defs[c.def] : null;
      if (!wasOnBoard) {
        resetCard(c);
        // "When an uma/unit is played, they normally enter exhausted."
        if (!enterReady && def && def.card_type === 'uma') c.exhausted = true;
      } else if (from !== toKind && G().EXHAUST_ON_MOVE !== false && !['env', 'pool', 'leader'].includes(toKind)
        && def && def.card_type !== 'star') {
        // Moving a card in play (base ⇄ lanes) exhausts it.
        c.exhausted = true;
      }
      if (LANES.includes(toKind)) c.faceDown = faceDown || (c.faceDown && LANES.includes(from));
      else c.faceDown = false;
      for (const k of kids) { detachFromZone(s, k); place(s, k, key); }
    }
    place(s, iid, key, pos);
    if (c.paid && !c.faceDown) settlePayment(s, iid);
  }

  // ---------- hidden payment for face-down plays ----------
  // Pay a card's cost automatically. With hide=true the opponent still sees
  // the Stars as they were (and recycled ones stay in the pool) until the
  // card is revealed; then the payment becomes visible.
  function payCost(s, me, iid, hide) {
    const c = s.cards[iid];
    const def = s.defs[c.def] || {};
    const energy = Number(def.energy || 0), power = Number(def.power || 0);
    const pool = (s.zones[`${me}:pool`] || []).map(x => s.cards[x]).filter(st => !st.mask);
    const types = def.types || [];
    // Power: recycle Stars of the card's types (already-exhausted ones first).
    const powerStars = pool.filter(st => types.includes((s.defs[st.def] || {}).types?.[0]))
      .sort((a, b) => Number(b.exhausted) - Number(a.exhausted)).slice(0, power);
    if (powerStars.length < power) throw new Error(`Not enough matching Stars to pay ${power} power.`);
    const used = new Set(powerStars.map(x => x.iid));
    // Energy: exhaust ready Stars (prefer types the card doesn't use).
    const energyStars = pool.filter(st => !used.has(st.iid) && !st.exhausted)
      .sort((a, b) => Number(types.includes((s.defs[a.def] || {}).types?.[0])) - Number(types.includes((s.defs[b.def] || {}).types?.[0])))
      .slice(0, energy);
    if (energyStars.length < energy) throw new Error(`Not enough ready Stars to pay ${energy} energy.`);
    for (const st of energyStars) {
      if (hide) st.mask = { by: iid, shownEx: st.exhausted };
      st.exhausted = true;
    }
    for (const st of powerStars) {
      if (hide) { st.mask = { by: iid, shownEx: st.exhausted, recycle: true }; st.exhausted = true; }
      else moveCard(s, st.iid, 'stars-bottom');
    }
    if (hide) c.paid = { energy, power };
    return { energy, power };
  }

  // The face-down card was revealed (or left play): show what it cost.
  function settlePayment(s, iid) {
    const c = s.cards[iid];
    if (!c || !c.paid) return;
    const paid = c.paid;
    delete c.paid;
    for (const st of Object.values(s.cards)) {
      if (!st.mask || st.mask.by !== iid) continue;
      const recycle = st.mask.recycle;
      delete st.mask;
      if (recycle) moveCard(s, st.iid, 'stars-bottom');
    }
    log(s, null, `${cardName(s, iid, false)} had cost ${paid.energy} energy${paid.power ? ` and ${paid.power} power` : ''}.`);
  }

  // How a card's exhausted state looks to a given viewer (hidden payments).
  function shownExhausted(c, viewer) {
    if (c.mask && c.owner !== viewer) return c.mask.shownEx;
    return c.exhausted;
  }

  function drawOne(s, pid) {
    const deck = s.zones[`${pid}:deck`];
    if (!deck.length) return false;
    const iid = deck.shift();
    place(s, iid, `${pid}:hand`);
    return true;
  }

  // What a given viewer is allowed to see of a card.
  function isHidden(s, c, viewer) {
    const kind = zoneKind(c.zone);
    if (kind === 'deck' || kind === 'stars') return true;
    if (kind === 'hand') return c.owner !== viewer && !s.players[c.owner].revealHand;
    if (c.faceDown) return c.owner !== viewer;
    return false;
  }

  // Label used in the log, respecting hidden information.
  function cardName(s, iid, viewerSafe = true) {
    const c = s.cards[iid];
    const def = s.defs && s.defs[c.def];
    if (!def) return 'a card';
    if (viewerSafe && (c.faceDown || ['hand', 'deck', 'stars'].includes(zoneKind(c.zone)))) return 'a card';
    return def.name;
  }

  function checkWinner(s) {
    if (s.winner) return;
    for (const pid of s.order) {
      if (s.players[pid].fans >= G().FANS_TO_WIN) {
        s.winner = pid;
        log(s, null, `${nameOf(s, pid)} reached ${G().FANS_TO_WIN} fans and wins!`);
      }
    }
  }

  function chainDestText(s, item) {
    if (item.kind === 'ability') return 'ability';
    if (ENV_SLOTS.includes(item.dest)) return `environment on ${ENV_LABEL[item.dest]}`;
    if (item.kind === 'unit') return `on the table, ${({ base: 'base', mini0: 'Mini lane 1', mini1: 'Mini lane 2', race: 'Race lane' })[item.dest] || 'base'}`;
    if (item.attachTo) return `attaching to ${cardName(s, item.attachTo)}`;
    return {
      base: 'to base', mini0: 'to Mini lane 1', mini1: 'to Mini lane 2', race: 'to the Race lane', trash: 'cast',
    }[item.dest] || 'to base';
  }

  const RAMPS = () => Math.max(1, G().RAMPS_PER_RACE || 3);

  // Fight checks: always after the last Ramp (before the Race). From round
  // MID_FIGHT_FROM_ROUND on, also one after Ramp MID_FIGHT_AFTER_RAMP.
  function isCheckpoint(s, ramp) {
    if (ramp === RAMPS()) return true;
    const mid = G().MID_FIGHT_AFTER_RAMP;
    return !!mid && ramp === mid && s.round >= (G().MID_FIGHT_FROM_ROUND || 2);
  }

  // A mini lane is contested when both players have cards in it.
  function contestedLanes(s) {
    return ['mini0', 'mini1'].filter(l => {
      const owners = new Set((s.zones['lane:' + l] || []).map(i => s.cards[i]).filter(c => c && !c.attachedTo).map(c => c.owner));
      return owners.size > 1;
    });
  }

  function enterCheckpoint(s) {
    const lanes = contestedLanes(s);
    if (!lanes.length) {
      log(s, null, 'No mini lane is contested, so the fight check is skipped.');
      leaveCheckpoint(s);
      return;
    }
    s.step = 3;
    s.fight = { choices: {}, result: null };
    log(s, null, `Fight check: ${lanes.map(l => LANE_LABEL[l]).join(' and ')} ${lanes.length > 1 ? 'are' : 'is'} contested. Both players choose Fight or Refuse (secretly).`);
  }

  function leaveCheckpoint(s) {
    s.fight = null;
    s.miniFight = false;
    if (s.ramp >= RAMPS()) { beginRace(s); return; }
    s.ramp++;
    s.step = 0;
    s.rampFirst = 1 - s.rampFirst;
    startOfRamp(s);
  }

  function beginRace(s) {
    for (const k of ['mini0', 'mini1']) {
      for (const iid of [...s.zones['lane:' + k]]) {
        detachFromZone(s, iid);
        place(s, iid, 'lane:race');
      }
    }
    s.phase = 'race';
    s.step = 0;
    log(s, null, 'The Race begins. The mini lanes merge into one Lane.');
  }

  // Start of a Tricks step: every face-down card in play is revealed.
  function revealFaceDown(s) {
    const list = Object.values(s.cards).filter(c => c.faceDown && BOARD.includes(zoneKind(c.zone)));
    if (!list.length) return;
    for (const c of list) c.faceDown = false;
    log(s, null, `Tricks step: revealed ${list.map(c => cardName(s, c.iid, false)).join(', ')}.`);
    for (const c of list) settlePayment(s, c.iid);
  }

  // Start of every Ramp: both players ready everything, channel Stars, draw 1.
  function startOfRamp(s) {
    if (G().AUTO_START_OF_RAMP === false) return;
    const notes = [];
    for (const pid of s.order) {
      for (const c of Object.values(s.cards)) {
        if (c.owner === pid && c.exhausted && BOARD.includes(zoneKind(c.zone))) c.exhausted = false;
        if (c.owner === pid && c.tmp) c.tmp = 0; // temporary might lasts until the next Ramp
        if (c.owner === pid && c.mask) {
          // Stars spent on a still-hidden card: energy ones ready as normal,
          // power ones stay reserved (they get recycled on reveal).
          if (c.mask.recycle) { c.exhausted = true; c.mask.shownEx = false; } else delete c.mask;
        }
      }
      const stars = s.zones[`${pid}:stars`];
      let ch = 0;
      for (let i = 0; i < G().STARS_PER_RAMP && stars.length; i++) {
        const iid = stars.shift();
        s.cards[iid].exhausted = false;
        place(s, iid, `${pid}:pool`);
        ch++;
      }
      const drew = drawOne(s, pid);
      if (!drew) notes.push(`${nameOf(s, pid)}'s deck is empty`);
      if (ch < G().STARS_PER_RAMP) notes.push(`${nameOf(s, pid)} is out of Stars`);
    }
    log(s, null, `Ramp ${s.ramp} begins: everyone readied, channeled ${G().STARS_PER_RAMP} Stars and drew 1.${notes.length ? ' (' + notes.join('; ') + ')' : ''}`);
  }

  function rampText(s) {
    const first = s.order[s.rampFirst];
    const second = s.order[1 - s.rampFirst];
    const r = `Ramp ${s.ramp} of ${RAMPS()}`;
    if (s.phase === 'mulligan') return { title: 'Mulligan', short: 'Mulligan', who: null, hint: 'Look at your starting hand. Keep it, or shuffle it back and draw a new one (once).' };
    if (s.phase === 'race') return { title: 'Race', short: 'Race', who: null, hint: `The mini lanes are one lane now. Assign might as combat damage to the other player's units. Reaction! and Duel cards can be played. If only your units are left at the end, gain +${G().RACE_FANS} fans.` };
    switch (s.step) {
      case 0: return { title: `${r} · Units`, short: 'Units', who: first, hint: `${nameOf(s, first)} plays units.` };
      case 1: return { title: `${r} · Units & tricks`, short: 'Units & tricks', who: second, hint: `${nameOf(s, second)} plays units and tricks.` };
      case 2: return { title: `${r} · Tricks`, short: 'Tricks', who: first, hint: `${nameOf(s, first)} plays tricks. Reveal In the Shadows cards now.` };
      default: {
        const last = s.ramp >= RAMPS();
        return { title: last ? 'End of Ramp · Fight?' : `After Ramp ${s.ramp} · Fight?`, short: 'Fight?', who: null,
          hint: `A mini lane is contested. Each player secretly chooses Fight or Refuse. Refusing costs ${G().REFUSE_FIGHT_FANS ?? 50} fans. Then ${last ? 'the Race begins' : `Ramp ${s.ramp + 1} begins`}.` };
      }
    }
  }

  // The whole round as a track of segments, for the turn bar.
  function phaseTrack(s) {
    const segs = [];
    let index = 0;
    if (s.phase === 'mulligan') {
      segs.push({ group: 'Start', label: 'Mulligan', who: null, key: 'mull' });
    }
    for (let r = 1; r <= RAMPS(); r++) {
      const firstIdx = ((s.phase === 'mulligan' ? s.rampFirst : s.rampFirst + (r - s.ramp)) % 2 + 2) % 2;
      const first = s.order[firstIdx], second = s.order[1 - firstIdx];
      segs.push({ group: `Ramp ${r}`, label: 'Units', who: first, key: `r${r}s0` });
      segs.push({ group: `Ramp ${r}`, label: 'Units & tricks', who: second, key: `r${r}s1` });
      segs.push({ group: `Ramp ${r}`, label: 'Tricks', who: first, key: `r${r}s2` });
      if (isCheckpoint(s, r)) segs.push({ group: r === RAMPS() ? 'End' : 'Fight', label: 'Fight?', who: null, key: `r${r}s3` });
    }
    segs.push({ group: 'Race', label: 'Race', who: null, key: 'race' });
    const key = s.phase === 'mulligan' ? 'mull' : s.phase === 'race' ? 'race' : `r${s.ramp}s${Math.min(s.step, 3)}`;
    index = Math.max(0, segs.findIndex(x => x.key === key));
    return { segs, index };
  }

  // ---------- actions ----------
  // Each action: (s, me, ...args) => log text (string), or null to skip logging.
  // Throw an Error with a friendly message to refuse.

  const A = {
    move(s, me, iid, dest, opts = {}) {
      const c = s.cards[iid];
      if (c.token && !BOARD.includes(dest) && !LANES.includes(dest) && !ENV_SLOTS.includes(dest)) {
        const nm = cardName(s, iid, false);
        moveCard(s, iid, dest);
        return `removed a ${nm} token`;
      }
      const fromKind = zoneKind(c.zone);
      const wasHidden = ['hand', 'deck', 'stars'].includes(fromKind);
      moveCard(s, iid, dest, opts);
      const goesHidden = ['hand', 'deck-top', 'deck-bottom'].includes(dest);
      let nm = cardName(s, iid, false);
      if (opts.faceDown) nm = 'a face-down card';
      else if (wasHidden && goesHidden) nm = 'a card';
      const where = {
        base: 'to base', hand: 'to hand', trash: 'to trash', 'deck-top': 'to the top of their deck',
        'deck-bottom': 'to the bottom of their deck', mini0: 'into Mini lane 1', mini1: 'into Mini lane 2',
        race: 'into the Race lane', pool: 'to their Star pool',
        'env:mini0': 'as the environment on Mini lane 1', 'env:mini1': 'as the environment on Mini lane 2',
        banish: 'to banishment (out of the game)', champion: 'to their Champion zone',
      }[dest] || 'somewhere';
      const verb = (wasHidden || fromKind === 'champion') && BOARD.includes(dest) ? 'played' : 'moved';
      return `${verb} ${nm} ${where}`;
    },

    toggleExhaust(s, me, iid) {
      const c = s.cards[iid];
      if (c.mask) throw new Error('This Star paid for a face-down card. It stays used until that card is revealed.');
      c.exhausted = !c.exhausted;
      return `${c.exhausted ? 'exhausted' : 'readied'} ${cardName(s, iid)}`;
    },

    readyAll(s, me) {
      let n = 0;
      for (const c of Object.values(s.cards)) {
        if (c.owner === me && c.exhausted && BOARD.includes(zoneKind(c.zone))) { c.exhausted = false; n++; }
      }
      return `readied all their units and Stars (${n})`;
    },

    draw(s, me, n = 1) {
      let got = 0;
      for (let i = 0; i < n; i++) if (drawOne(s, me)) got++;
      if (!got) throw new Error('Your deck is empty.');
      return `drew ${got} card${got > 1 ? 's' : ''}`;
    },

    shuffleDeck(s, me) {
      U.shuffle(s.zones[`${me}:deck`]);
      return 'shuffled their deck';
    },

    channel(s, me, n = G().STARS_PER_RAMP) {
      const stars = s.zones[`${me}:stars`];
      let got = 0;
      for (let i = 0; i < n && stars.length; i++) {
        const iid = stars.shift();
        s.cards[iid].exhausted = false;
        place(s, iid, `${me}:pool`);
        got++;
      }
      if (!got) throw new Error('No Stars left to channel.');
      return `channeled ${got} Star${got > 1 ? 's' : ''}`;
    },

    recycle(s, me, iid) {
      if (s.cards[iid].mask) throw new Error('This Star paid for a face-down card. It stays used until that card is revealed.');
      const nm = cardName(s, iid);
      moveCard(s, iid, 'stars-bottom');
      return `recycled a ${nm}`;
    },

    trash(s, me, iid) {
      const nm = cardName(s, iid, false);
      const tok = s.cards[iid].token;
      moveCard(s, iid, 'trash');
      return tok ? `removed a ${nm} token` : `trashed ${nm}`;
    },

    might(s, me, iid, d) {
      const c = s.cards[iid];
      c.might += d;
      const base = Number((s.defs[c.def] || {}).might || 0);
      return `${d > 0 ? 'gave +' + d : 'gave ' + d} might to ${cardName(s, iid)} (now ${base + c.might})`;
    },

    damage(s, me, iid, d) {
      const c = s.cards[iid];
      c.dmg = Math.max(0, c.dmg + d);
      return d > 0 ? `marked ${d} damage on ${cardName(s, iid)} (${c.dmg} total)` : `removed damage from ${cardName(s, iid)} (${c.dmg} left)`;
    },

    tempMight(s, me, iid, d) {
      const c = s.cards[iid];
      c.tmp = (c.tmp || 0) + d;
      return `${d > 0 ? 'gave +' + d : 'gave ' + d} temporary might to ${cardName(s, iid)} (${c.tmp >= 0 ? '+' : ''}${c.tmp} until the next Ramp)`;
    },

    banish(s, me, iid) {
      const c = s.cards[iid];
      const nm = cardName(s, iid, false);
      // remove it from the chain too, if it's there
      const ci = s.chain.findIndex(x => x.iid === iid);
      if (ci >= 0) { s.chain.splice(ci, 1); s.priority = s.chain.length ? opp(s, s.chain[s.chain.length - 1].by) : null; }
      if (c.token) { moveCard(s, iid, 'trash'); return `banished a ${nm} token`; }
      moveCard(s, iid, 'banish');
      return `banished ${nm}`;
    },

    clearCounters(s, me, iid) {
      const c = s.cards[iid];
      c.dmg = 0; c.might = 0; c.tmp = 0;
      return `cleared counters on ${cardName(s, iid)}`;
    },

    ping(s, me, iid) {
      s.pings.push({ iid, by: me, n: (s.pings.length ? s.pings[s.pings.length - 1].n : 0) + 1 });
      if (s.pings.length > 10) s.pings.shift();
      return `pinged ${cardName(s, iid)}`;
    },

    arrow(s, me, from, to) {
      s.arrows.push({ from, to, by: me });
      return `pointed ${cardName(s, from)} at ${cardName(s, to)}`;
    },

    clearArrows(s, me) {
      s.arrows = s.arrows.filter(a => a.by !== me);
      return null;
    },

    flip(s, me, iid) {
      const c = s.cards[iid];
      c.faceDown = !c.faceDown;
      if (!c.faceDown) settlePayment(s, iid);
      return c.faceDown ? 'turned a card face-down' : `revealed ${cardName(s, iid)}`;
    },

    // ----- the chain -----
    // Play a card from hand. It goes on the chain (face-up, big in the chain
    // panel) and the other player gets the call. Face-down plays skip it.
    play(s, me, iid, dest, opts = {}) {
      const c = s.cards[iid];
      if (!['hand', 'champion'].includes(zoneKind(c.zone)) || c.owner !== me) throw new Error('You can only play cards from your own hand or Champion zone.');
      const d0 = s.defs && s.defs[c.def];
      // Spells (tricks) never go onto the table: they go on the chain, then to the trash.
      // Environments are the exception: they go to an environment slot.
      if (d0 && d0.card_type === 'trick' && !(d0.keywords || []).includes('environment') && !opts.faceDown) dest = 'trash';
      if (opts.faceDown) {
        if (!opts.noPay) payCost(s, me, iid, true); // paid now, shown to the opponent when revealed
        moveCard(s, iid, dest, opts);
        return `played a face-down card into ${LANE_LABEL[dest] || 'a lane'}`;
      }
      if (G().USE_CHAIN === false) {
        if (opts.attachTo) return A.attach(s, me, iid, opts.attachTo);
        return A.move(s, me, iid, dest, opts);
      }
      const responding = s.chain.length > 0;
      const def = s.defs && s.defs[c.def];
      const from = zoneKind(c.zone);
      // Units land on the table right away; they also show on the chain so
      // the other player can still respond (or counter them).
      if (def && def.card_type === 'uma' && !opts.attachTo && dest && dest !== 'trash') {
        moveCard(s, iid, dest);
        s.chain.push({ n: ++s.chainSeq, kind: 'unit', iid, by: me, dest, from });
        s.priority = opp(s, me);
        return `${responding ? 'responded with' : 'played'} ${cardName(s, iid, false)} (${chainDestText(s, s.chain[s.chain.length - 1])})`;
      }
      detachFromZone(s, iid);
      resetCard(c);
      place(s, iid, 'shared:chain');
      s.chain.push({ n: ++s.chainSeq, kind: 'play', iid, by: me, dest: dest || null, attachTo: opts.attachTo || null, from });
      s.priority = opp(s, me);
      return `${responding ? 'responded with' : 'played'} ${cardName(s, iid, false)} (${chainDestText(s, s.chain[s.chain.length - 1])})`;
    },

    ability(s, me, iid) {
      const c = s.cards[iid];
      if (!BOARD.includes(zoneKind(c.zone))) throw new Error('Only cards in play can use abilities.');
      const responding = s.chain.length > 0;
      s.chain.push({ n: ++s.chainSeq, kind: 'ability', iid, by: me });
      s.priority = opp(s, me);
      return `${responding ? 'responded with' : 'used'} ${cardName(s, iid)}'s ability`;
    },

    resolve(s, me, force = false) {
      if (!s.chain.length) throw new Error('The chain is empty.');
      if (!force && s.priority && s.priority !== me) throw new Error(`It's ${nameOf(s, s.priority)}'s call: they can respond or resolve.`);
      const item = s.chain.pop();
      let text;
      if (item.kind === 'ability') {
        text = `resolved ${cardName(s, item.iid)}'s ability`;
      } else if (item.kind === 'unit') {
        text = `resolved ${cardName(s, item.iid, false)}`;
      } else {
        const nm = cardName(s, item.iid, false);
        const target = item.attachTo && s.cards[item.attachTo];
        if (target && BOARD.includes(zoneKind(target.zone))) A.attach(s, item.by, item.iid, item.attachTo);
        else moveCard(s, item.iid, item.dest && item.dest !== 'attach' ? item.dest : 'base');
        text = `resolved ${nm}`;
      }
      s.priority = s.chain.length ? opp(s, s.chain[s.chain.length - 1].by) : null;
      return text;
    },

    counter(s, me, n) {
      const i = s.chain.findIndex(x => x.n === n);
      if (i < 0) throw new Error('That is no longer on the chain.');
      const [item] = s.chain.splice(i, 1);
      let text;
      if (item.kind === 'ability') text = `countered ${cardName(s, item.iid)}'s ability`;
      else if (item.kind === 'unit') {
        text = `countered ${cardName(s, item.iid, false)}`;
        if (s.cards[item.iid] && BOARD.includes(zoneKind(s.cards[item.iid].zone))) moveCard(s, item.iid, 'trash');
      } else {
        text = `countered ${cardName(s, item.iid, false)}`;
        moveCard(s, item.iid, 'trash');
      }
      s.priority = s.chain.length ? opp(s, s.chain[s.chain.length - 1].by) : null;
      return text;
    },

    takeBack(s, me, n) {
      const i = s.chain.findIndex(x => x.n === n);
      const item = s.chain[i];
      if (!item || item.by !== me) throw new Error('You can only take back your own play.');
      if (i !== s.chain.length - 1) throw new Error('Something was played on top of it. Resolve or counter that first.');
      s.chain.pop();
      if (item.kind === 'play' || item.kind === 'unit') moveCard(s, item.iid, item.from === 'champion' ? 'champion' : 'hand');
      s.priority = s.chain.length ? opp(s, s.chain[s.chain.length - 1].by) : null;
      return `took back ${item.kind === 'play' ? 'a card' : 'an ability'}`;
    },

    attach(s, me, iid, targetIid) {
      const t = s.cards[targetIid];
      const c = s.cards[iid];
      if (iid === targetIid) throw new Error("A card can't attach to itself.");
      if (!BOARD.includes(zoneKind(t.zone))) throw new Error('You can only attach to a card in play.');
      const fromHand = !BOARD.includes(zoneKind(c.zone));
      detachFromZone(s, iid);
      if (fromHand) resetCard(c);
      c.faceDown = false;
      c.attachedTo = targetIid;
      // Place right after the target so it renders with it.
      const arr = s.zones[t.zone];
      arr.splice(arr.indexOf(targetIid) + 1, 0, iid);
      c.zone = t.zone;
      return `attached ${cardName(s, iid, false)} to ${cardName(s, targetIid)}`;
    },

    detach(s, me, iid) {
      const c = s.cards[iid];
      c.attachedTo = null;
      return `detached ${cardName(s, iid)}`;
    },

    give(s, me, iid) {
      const c = s.cards[iid];
      if (c.token) throw new Error("Tokens can't go to a hand. Trash it instead.");
      const to = opp(s, c.owner);
      const nm = cardName(s, iid);
      detachFromZone(s, iid);
      for (const k of attachmentsOf(s, iid)) s.cards[k].attachedTo = null;
      resetCard(c);
      c.owner = to;
      place(s, iid, `${to}:hand`);
      return `gave ${nm} to ${nameOf(s, to)}`;
    },

    conjure(s, me, defId, dest = 'hand') {
      const iid = addInstance(s, defId, me, null);
      s.cards[iid].conjured = true;
      place(s, iid, `${me}:hand`);
      if (dest !== 'hand') moveCard(s, iid, dest);
      return `conjured ${s.defs[defId].name}${dest === 'hand' ? ' into their hand' : ''}`;
    },

    // Conjure from a card's settings. The random picks are made by the
    // player's browser and passed in, so every copy of the table agrees.
    conjureFrom(s, me, srcIid, defIds, dest = 'hand') {
      const made = [];
      for (const id of defIds) {
        if (!s.defs[id]) continue;
        const iid = addInstance(s, id, me, null);
        s.cards[iid].conjured = true;
        place(s, iid, `${me}:hand`);
        if (dest !== 'hand') moveCard(s, iid, dest);
        made.push(s.defs[id].name);
      }
      if (!made.length) throw new Error('Nothing to conjure.');
      const where = ({ hand: 'into their hand', base: 'onto their base', 'deck-top': 'onto the top of their deck' })[dest] || '';
      // Cards going to hand or deck stay secret from the other player.
      const what = dest === 'base' ? made.join(', ') : `${made.length} card${made.length > 1 ? 's' : ''}`;
      return `conjured ${what} ${where} with ${cardName(s, srcIid, false)}`;
    },

    // Create token(s) straight onto the table (not on the chain).
    createToken(s, me, tokenId, dest = 'base', count = 1, ready = false) {
      const def = s.defs[tokenId];
      if (!def || !def.token) throw new Error('Unknown token.');
      const n = Math.max(1, Math.min(10, Number(count) || 1));
      for (let i = 0; i < n; i++) {
        const iid = addInstance(s, tokenId, me, null);
        s.cards[iid].token = true;
        place(s, iid, `${me}:hand`);
        moveCard(s, iid, dest, { enterReady: ready });
      }
      const where = { base: 'on their base', mini0: 'in Mini lane 1', mini1: 'in Mini lane 2', race: 'in the Race lane' }[dest] || '';
      return `created ${n > 1 ? n + ' ' : 'a '}${def.name} token${n > 1 ? 's' : ''} ${where}`;
    },

    revealHand(s, me) {
      const p = s.players[me];
      p.revealHand = !p.revealHand;
      return p.revealHand ? 'revealed their hand' : 'hid their hand again';
    },

    fans(s, me, pid, d) {
      const p = s.players[pid];
      p.fans = p.fans + d; // can go negative
      checkWinner(s);
      if (pid === me) return d >= 0 ? `gained ${d} fans (now ${p.fans})` : `lost ${-d} fans (now ${p.fans})`;
      return d >= 0 ? `gave ${nameOf(s, pid)} +${d} fans (now ${p.fans})` : `took ${-d} fans from ${nameOf(s, pid)} (now ${p.fans})`;
    },

    nextStep(s, me) {
      // (An open chain doesn't stop the turn from moving on.)
      if (s.phase === 'mulligan') throw new Error('Both players need to keep or mulligan first.');
      if (s.phase !== 'ramp' || s.step >= 3) throw new Error('Use the buttons for the fight check or the Race.');
      if (s.step < 2) {
        s.step++;
        const t = rampText(s);
        log(s, me, `passed. Now: ${t.title} (${nameOf(s, t.who)})`);
        if (s.step === 2) revealFaceDown(s);
        return null;
      }
      log(s, me, 'passed.');
      if (isCheckpoint(s, s.ramp)) enterCheckpoint(s);
      else leaveCheckpoint(s);
      return null;
    },

    // Secret choice at a fight check. The other player only sees that you chose.
    fightChoice(s, me, choice) {
      if (s.step !== 3 || !s.fight) throw new Error('There is no fight check right now.');
      if (s.fight.result) throw new Error('Both players already chose.');
      s.fight.choices[me] = choice === 'fight' ? 'fight' : 'refuse';
      if (!s.order.every(pid => s.fight.choices[pid])) return 'made their choice';
      log(s, me, 'made their choice');
      const refusers = s.order.filter(pid => s.fight.choices[pid] === 'refuse');
      const cost = G().REFUSE_FIGHT_FANS ?? 50;
      for (const pid of refusers) s.players[pid].fans -= cost;
      const parts = s.order.map(pid => `${nameOf(s, pid)} ${s.fight.choices[pid] === 'fight' ? 'fights' : `refuses (−${cost} fans)`}`);
      if (!refusers.length) {
        s.fight.result = 'fight';
        s.miniFight = true;
        log(s, null, `Both chose to fight! Fight in the mini lanes.`);
      } else {
        s.fight.result = 'refused';
        log(s, null, `Choices revealed: ${parts.join(', ')}. No fight.`);
      }
      checkWinner(s);
      return null;
    },

    // Move on from a fight check (to the next Ramp, or into the Race).
    continueOn(s, me) {
      if (s.step !== 3) throw new Error('Nothing to continue from.');
      if (s.fight && !s.fight.result) throw new Error('Both players choose Fight or Refuse first.');
      log(s, me, s.ramp >= RAMPS() ? 'began the Race.' : `moved on to Ramp ${s.ramp + 1}.`);
      leaveCheckpoint(s);
      return null;
    },

    // kept for older tables: same as continuing into the Race
    startRace(s, me) {
      if (s.phase === 'race') throw new Error('The Race already started.');
      s.ramp = RAMPS();
      leaveCheckpoint(s);
      return 'started the Race.';
    },

    endRace(s, me) {
      if (G().ENVIRONMENTS_AFTER_RACE !== 'stay') {
        for (const k of ENV_SLOTS) for (const iid of [...(s.zones[k] || [])]) {
          const nm = cardName(s, iid, false);
          moveCard(s, iid, 'trash');
          log(s, null, `${nm} (environment) went to the trash.`);
        }
      }
      if (G().RETURN_UNITS_AFTER_RACE) {
        for (const iid of [...s.zones['lane:race']]) {
          const c = s.cards[iid];
          detachFromZone(s, iid);
          place(s, iid, `${c.owner}:base`);
        }
      }
      for (const c of Object.values(s.cards)) if (c.tmp) c.tmp = 0;
      s.phase = 'ramp';
      s.step = 0;
      s.ramp = 1;
      s.round++;
      s.rampFirst = 1 - s.rampFirst;
      s.arrows = [];
      log(s, me, `ended the Race. Round ${s.round}: ${nameOf(s, s.order[s.rampFirst])} plays units first.`);
      startOfRamp(s);
      return null;
    },

    // Start of the match: keep the hand, or shuffle it back and draw a new one.
    mulligan(s, me, choice) {
      if (s.phase !== 'mulligan') throw new Error('Mulligans happen at the start of the match.');
      if (s.mulligan[me]) throw new Error('You already decided.');
      let text = 'kept their hand';
      if (choice === 'redraw') {
        const hand = s.zones[`${me}:hand`];
        const n = hand.length;
        for (const iid of [...hand]) { detachFromZone(s, iid); place(s, iid, `${me}:deck`); }
        U.shuffle(s.zones[`${me}:deck`]);
        for (let i = 0; i < n; i++) drawOne(s, me);
        text = `mulliganed (drew ${n} new cards)`;
      }
      s.mulligan[me] = choice === 'redraw' ? 'redraw' : 'keep';
      log(s, me, text);
      if (s.order.every(pid => s.mulligan[pid])) {
        s.phase = 'ramp';
        s.step = 0;
        startOfRamp(s);
      }
      return null;
    },

    note(s, me, text) {
      return String(text).slice(0, 120);
    },

    concede(s, me) {
      s.winner = opp(s, me);
      return 'conceded';
    },
  };

  // Apply an action to a state. Returns the new state (or throws).
  function apply(state, defs, me, name, args) {
    if (name === 'undo') {
      if (!state.undo || state.undo.by !== me) throw new Error('Nothing of yours to undo.');
      const prev = state.undo.state;
      prev.undo = null;
      log(prev, me, 'undid their last action');
      return prev;
    }
    if (!state.chain) { state.chain = []; state.priority = null; state.chainSeq = 0; }
    if (!state.zones['shared:chain']) state.zones['shared:chain'] = [];
    for (const k of ENV_SLOTS) if (!state.zones[k]) state.zones[k] = [];
    for (const pid of state.order) for (const z of PLAYER_ZONES) if (!state.zones[`${pid}:${z}`]) state.zones[`${pid}:${z}`] = [];
    if (state.phase === 'ramp' && state.step === 3 && !state.fight) state.fight = { choices: {}, result: null };
    if (!state.mulligan) state.mulligan = {};
    const snapshot = U.clone(state);
    snapshot.undo = null;
    const s = state;
    Object.defineProperty(s, 'defs', { value: defs, enumerable: false, configurable: true });
    const text = A[name](s, me, ...args);
    delete s.defs;
    if (text) log(s, me, text);
    // Secret choices and fresh draws can't be undone (you'd see hidden info).
    s.undo = ['fightChoice', 'mulligan'].includes(name) ? null : { by: me, state: snapshot };
    return s;
  }

  return {
    LANES, LANE_LABEL, BOARD, newMatchState, buildMatch, slimDef, apply, isHidden, opp, nameOf,
    ENV_SLOTS, ENV_LABEL, zoneKind, zoneOwner, rampText, phaseTrack, attachmentsOf, chainDestText,
    shownExhausted, contestedLanes, isCheckpoint, RAMPS,
  };
})();
