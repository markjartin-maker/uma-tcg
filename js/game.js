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
      rampFirst: 0, // set by the dice roll below
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
      s.players[p.id] = { name: p.name, fans: 0, revealHand: false, sleeve: p.deck && p.deck.sleeve ? p.deck.sleeve : null };
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
    // Dice roll for who goes first (a tie for the highest roll rolls again).
    const d6 = () => 1 + (crypto.getRandomValues(new Uint32Array(1))[0] % 6);
    s.dice = { rolls: [] };
    let roll, top;
    do {
      roll = s.order.map(() => d6());
      s.dice.rolls.push(roll);
      top = Math.max(...roll);
    } while (roll.filter(v => v === top).length > 1 && s.dice.rolls.length < 20);
    if (roll.filter(v => v === top).length > 1) { roll = roll.map((v, i) => (v === top && i > roll.indexOf(top) ? v - 1 : v)); s.dice.rolls[s.dice.rolls.length - 1] = roll; }
    s.rampFirst = roll.indexOf(Math.max(...roll));
    s.dice.first = s.order[s.rampFirst];
    const nm = i => s.players[s.order[i]].name;
    const ties = s.dice.rolls.length - 1;
    log(s, null, `Dice roll: ${s.order.map((p, i) => `${nm(i)} rolled ${roll[i]}`).join(', ')}${ties ? ` (after ${ties} tie${ties > 1 ? 's' : ''})` : ''}. ${nm(s.rampFirst)} plays units first.`);
    log(s, null, `${s.order.length > 2 ? 'Everyone' : 'Both players'}: keep your hand or mulligan.`);
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

  // A 3–4 player match from a full lobby room. room.members: [{ user, deck }]
  async function buildRoomMatch(backend, room) {
    const [decks, pool, profiles] = await Promise.all([
      Promise.all(room.members.map(m => backend.getDeck(m.deck))), backend.listCards(), backend.listProfiles(),
    ]);
    if (decks.some(d => !d)) throw new Error('One of the decks no longer exists.');
    const defs = {};
    for (const c of pool) defs[c.id] = slimDef(c);
    for (const t of Cards.TYPES) defs['star:' + t.id] = Cards.starDef(t.id);
    for (const t of Cards.TOKENS) defs[t.id] = t;
    const name = id => (profiles.find(p => p.id === id) || {}).display_name || 'Player';
    const state = newMatchState(room.members.map((m, i) => ({ id: m.user, name: name(m.user), deck: decks[i] })), defs);
    const ids = room.members.map(m => m.user);
    return { p1: ids[0], p2: ids[1], players: ids, state, defs };
  }

  function slimDef(c) {
    return { id: c.id, name: c.name, card_type: c.card_type, types: c.types, energy: c.energy, power: c.power,
      might: c.might, keywords: c.keywords || [], effect: c.effect || '', image_url: c.image_url || null,
      rarity: c.rarity || 'common', full_art: !!c.full_art, subtitle: c.subtitle || null,
      tags: c.tags || [], conjure: c.conjure || null, signature_of: c.signature_of || null,
      play_anim: c.play_anim || null,
      ...(c.code ? { code: c.code } : {}),
      ...(c.is_token ? { token: true } : {}) };
  }

  // ---------- helpers ----------

  const opp = (s, pid) => s.order.find(p => p !== pid);
  // ---- players and steps (1v1, 1v1v1, 1v1v1v1) ----
  const N = s => s.order.length;
  const isMulti = s => s.order.length > 2;
  const nextPlayer = (s, pid) => s.order[(s.order.indexOf(pid) + 1) % s.order.length];
  const others = (s, pid) => s.order.filter(p => p !== pid);
  // The fight check's step number: after 3 steps in 1v1, after 2N steps otherwise.
  const CHECK = s => (isMulti(s) ? 2 * N(s) : 3);
  // Who acts in a step and what kind it is.
  //   1v1:  Units (A) → Units & tricks (B) → Tricks (A)
  //   more: Units A → B → C (→ D), then Tricks back the other way (D →) C → B → A
  function stepInfo(s, step = s.step, first = s.rampFirst) {
    const n = N(s);
    if (!isMulti(s)) {
      if (step === 0) return { who: s.order[first], kind: 'units' };
      if (step === 1) return { who: s.order[(first + 1) % n], kind: 'unitsTricks' };
      if (step === 2) return { who: s.order[first], kind: 'tricks' };
      return { who: null, kind: 'check' };
    }
    if (step < n) return { who: s.order[(first + step) % n], kind: 'units' };
    if (step < 2 * n) return { who: s.order[(first + (2 * n - 1 - step)) % n], kind: 'tricks' };
    return { who: null, kind: 'check' };
  }
  const firstTricksStep = s => (isMulti(s) ? N(s) : 2);
  // Fans needed to win this match (depends on how many players there are).
  function winTarget(s) {
    const t = G().FANS_TO_WIN;
    if (typeof t === 'number') return t;
    const n = s && s.order ? s.order.length : 2;
    return (t && (t[n] || t[Math.min(4, Math.max(2, n))])) || 1000;
  }
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
      if (wasOnBoard) fire(s, 'leaves play', [c], () => ({ here: LANES.includes(from) ? from : null }));
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
    if (LANES.includes(toKind) && from !== toKind && !c.faceDown) fire(s, 'enters lane', [c]);
    if (wasOnBoard && from !== 'pool' && !toBoard) fire(s, 'leaves play', [c], () => ({ here: LANES.includes(from) ? from : null }));
  }

  // ---------- hidden payment for face-down plays ----------
  // Pay a card's cost automatically. With hide=true the opponent still sees
  // the Stars as they were (and recycled ones stay in the pool) until the
  // card is revealed; then the payment becomes visible.
  function payCost(s, me, iid, hide) {
    const c = s.cards[iid];
    const def = s.defs[c.def] || {};
    const mods = activeMods(s, s.defs);
    const energy = effCost(s, s.defs, c, 'energy', mods), power = effCost(s, s.defs, c, 'power', mods);
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
    fire(s, 'drawn', [s.cards[iid]]);
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
      if (s.players[pid].fans >= winTarget(s)) {
        s.winner = pid;
        log(s, null, `${nameOf(s, pid)} reached ${winTarget(s)} fans and wins!`);
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
      leaveCheckpoint(s, true);
      return;
    }
    s.step = CHECK(s);
    s.fight = { choices: {}, result: null };
    log(s, null, `Fight check: ${lanes.map(l => LANE_LABEL[l]).join(' and ')} ${lanes.length > 1 ? 'are' : 'is'} contested. ${isMulti(s) ? 'Everyone chooses' : 'Both players choose'} Fight or Refuse (secretly).`);
  }

  // Holding a mini lane (only your cards there) is worth MINI_LANE_FANS,
  // scored automatically whenever a fight check ends.
  function leaveCheckpoint(s, award = false) {
    s.fight = null;
    s.miniFight = false;
    if (s.ramp >= RAMPS()) { beginRace(s); return; }
    s.ramp++;
    s.step = 0;
    s.rampFirst = (s.rampFirst + 1) % N(s); // who goes first moves on each Ramp
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
    fireBoard(s, 'race starts');
  }

  // Start of a Tricks step: every face-down card in play is revealed.
  function revealFaceDown(s) {
    const list = Object.values(s.cards).filter(c => c.faceDown && BOARD.includes(zoneKind(c.zone)));
    if (!list.length) return;
    for (const c of list) c.faceDown = false;
    log(s, null, `Tricks step: revealed ${list.map(c => cardName(s, c.iid, false)).join(', ')}.`);
    for (const c of list) settlePayment(s, c.iid);
    fire(s, 'revealed', list);
  }

  // Holding: when a player's Units (or Units & tricks) step begins, they get
  // MINI_LANE_FANS for each mini lane where only their cards are.
  function scoreHolds(s, pid) {
    if (G().AUTO_HOLD_FANS === false || s.phase !== 'ramp') return;
    const pts = G().MINI_LANE_FANS ?? 50;
    const held = ['mini0', 'mini1'].filter(l => {
      const owners = new Set((s.zones['lane:' + l] || []).map(i => s.cards[i]).filter(c => c && !c.attachedTo).map(c => c.owner));
      return owners.size === 1 && owners.has(pid);
    });
    if (!held.length) return;
    fireBoard(s, 'hold', pid, c => ({ here: laneOf(c) || held[0] }));
    const gain = pts * held.length;
    // A hold that would win the match starts a showdown instead.
    if (G().SHOWDOWN !== false && s.players[pid].fans + gain >= winTarget(s)) {
      if (s.showdown) { log(s, null, `${nameOf(s, pid)} holds ${held.map(l => LANE_LABEL[l]).join(' and ')}, but a showdown is already on.`); return; }
      s.showdown = { pid, lane: held[0], lanes: held, pts: gain, active: false, made: s.round * 100 + s.ramp * 10 + s.step };
      log(s, null, `${nameOf(s, pid)} holds ${held.map(l => LANE_LABEL[l]).join(' and ')} and would reach ${winTarget(s)} fans! No fans yet: a SHOWDOWN starts at ${isMulti(s) ? 'the next Units step of another player' : `${nameOf(s, opp(s, pid))}'s next Units step`}.`);
      return;
    }
    s.players[pid].fans += gain;
    log(s, null, `${nameOf(s, pid)} holds ${held.map(l => LANE_LABEL[l]).join(' and ')}: +${pts * held.length} fans.`);
    checkWinner(s);
  }

  // ---------- card code (js/cardcode.js) ----------
  // Rules written on cards. "while/always" rules change costs and might while
  // the card is somewhere; "when" rules ask their owner "Do it / Skip?" when
  // something happens; "ability" rules add a menu item.

  // A seeded random number, kept in the state, so every copy agrees.
  function rand(s) {
    if (s.rng == null) s.rng = (s.seq * 2654435761 + s.log.length * 40503) >>> 0;
    let t = (s.rng = (s.rng + 0x6D2B79F5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const pickN = (s, list, n) => {
    const a = [...list];
    const out = [];
    while (a.length && out.length < n) out.push(a.splice(Math.floor(rand(s) * a.length), 1)[0]);
    return out;
  };
  const rulesFor = (defs, c) => (window.CardCode && c && defs && defs[c.def] ? CardCode.rulesOf(defs[c.def]) : []);
  // The lane a card is in (an environment counts as being in its lane).
  const laneOf = c => (c && c.zone ? (c.zone.startsWith('lane:') ? c.zone.slice(5) : c.zone.startsWith('env:') ? c.zone.slice(4) : null) : null);
  const inPlay = c => c && BOARD.includes(zoneKind(c.zone)) && zoneKind(c.zone) !== 'pool';

  // Is a card where a "while …" rule needs it?
  function placeOk(c, place) {
    if (!c || c.faceDown) return false;
    const k = zoneKind(c.zone);
    switch (place) {
      case 'board': return inPlay(c);
      case 'lane': return LANES.includes(k);
      case 'race': return k === 'race';
      case 'base': return k === 'base';
      case 'hand': return k === 'hand';
      default: return false;
    }
  }
  const PLACE_TEST = {
    here: (c, ctx) => !!ctx.here && c.zone === 'lane:' + ctx.here,
    lane: c => LANES.includes(zoneKind(c.zone)),
    race: c => c.zone === 'lane:race',
    base: c => zoneKind(c.zone) === 'base',
    hand: c => zoneKind(c.zone) === 'hand',
    trash: c => zoneKind(c.zone) === 'trash',
    board: c => inPlay(c),
  };
  function kindOk(def, c, kind) {
    const tok = !!(c.token || def.token);
    switch (kind) {
      case 'uma': return def.card_type === 'uma' || (tok && def.card_type !== 'trick');
      case 'trick': return def.card_type === 'trick' && !Cards.isEnvironment(def);
      case 'environment': return Cards.isEnvironment(def);
      case 'token': return tok;
      case 'trainer': return def.card_type === 'trainer' || def.card_type === 'gear';
      case 'card': return def.card_type !== 'star';
      default: return def.card_type === kind;
    }
  }
  const CMP = { le: (a, b) => a <= b, ge: (a, b) => a >= b, lt: (a, b) => a < b, gt: (a, b) => a > b, eq: (a, b) => a === b, ne: (a, b) => a !== b };
  const baseMight = (defs, c) => { const d = defs[c.def] || {}; return (Cards.hasMight(d) ? Number(d.might) : 0) + (c.might || 0) + (c.tmp || 0); };

  // Does one card fit a selector? ctx: { src, owner, here }
  function selMatches(s, defs, sel, c, ctx) {
    if (!c) return false;
    if (sel.me) return c.iid === ctx.src;
    const def = defs[c.def];
    if (!def || def.card_type === 'star') return false;
    if (sel.rel === 'my' && c.owner !== ctx.owner) return false;
    if (sel.rel === 'enemy' && c.owner === ctx.owner) return false;
    if (sel.kinds.length && !sel.kinds.some(k => kindOk(def, c, k))) return false;
    if (!sel.kinds.length && def.card_type === 'superhorse') return false;
    if (sel.kinds.length && !sel.kinds.includes('card') && def.card_type === 'superhorse') return false;
    if (sel.colors.length && !(def.types || []).some(t => sel.colors.includes(t))) return false;
    if (sel.where && !PLACE_TEST[sel.where](c, ctx)) return false;
    for (const f of sel.flags) {
      if (f === 'conjured' && !c.conjured) return false;
      if (f === 'champion' && !(c.champion || Cards.isChampion(def))) return false;
      if (f === 'signature' && !Cards.isSignature(def)) return false;
      if (f === 'exhausted' && !c.exhausted) return false;
      if (f === 'ready' && c.exhausted) return false;
      if (f === 'damaged' && !c.dmg) return false;
      if (f === 'face-down' && !c.faceDown) return false;
    }
    for (const t of sel.tags) if (!(def.tags || []).includes(t)) return false;
    for (const k of sel.keywords) if (!(def.keywords || []).some(x => x === k || Cards.kwSlug(x) === Cards.kwSlug(k))) return false;
    for (const m of sel.cmp) {
      const v = m.field === 'might' ? baseMight(defs, c) : Number(def[m.field === 'power' ? 'power' : 'energy'] || 0);
      if (!CMP[m.op](v, numVal(s, defs, m.val, ctx))) return false;
    }
    return true;
  }

  // Every card that fits (actions without a place look at cards in play).
  function selectAll(s, defs, sel, ctx) {
    return Object.values(s.cards).filter(c => (sel.me || sel.where || inPlay(c)) && !c.attachedTo && selMatches(s, defs, sel, c, ctx)).map(c => c.iid);
  }
  function selectPick(s, defs, sel, ctx) {
    const all = selectAll(s, defs, sel, ctx);
    if (sel.me || sel.quant === 'all') return all;
    return pickN(s, all, sel.n || 1);
  }
  function numVal(s, defs, n, ctx) {
    if (!n) return 0;
    if (n.n != null) return n.n;
    if (n.count) return selectAll(s, defs, n.count, ctx).length;
    if (n.mul) return numVal(s, defs, n.mul[0], ctx) * numVal(s, defs, n.mul[1], ctx);
    return 0;
  }

  // All the "while/always" changes in effect right now.
  function activeMods(s, defs) {
    const out = [];
    for (const c of Object.values(s.cards)) {
      const rules = rulesFor(defs, c);
      if (!rules.length) continue;
      for (const r of rules) {
        if ((r.kind !== 'while' && r.kind !== 'always') || !placeOk(c, r.place)) continue;
        for (const m of r.mods) out.push({ m, ctx: { src: c.iid, owner: c.owner, here: laneOf(c) } });
      }
    }
    return out;
  }
  // A card's cost after changes. stat: 'energy' | 'power'.
  function effCost(s, defs, c, stat = 'energy', mods = activeMods(s, defs)) {
    const def = defs[c.def] || {};
    const base = Number(def[stat] || 0);
    let d = 0;
    for (const { m, ctx } of mods) {
      if ((stat === 'energy' ? m.stat !== 'cost' : m.stat !== 'power')) continue;
      if (selMatches(s, defs, m.sel, c, ctx)) d += m.delta;
    }
    return Math.max(0, base + d);
  }
  // Extra might from "… get +N might" rules.
  function auraMight(s, defs, c, mods = activeMods(s, defs)) {
    let d = 0;
    for (const { m, ctx } of mods) if (m.stat === 'might' && selMatches(s, defs, m.sel, c, ctx)) d += m.delta;
    return d;
  }

  // ----- "when" rules → questions for the owner -----
  function fire(s, trigger, cards, ctxFor = () => ({})) {
    const defs = s.defs;
    if (!defs || !window.CardCode || s.phase === 'mulligan') return;
    for (const c of cards) {
      if (!c || c.faceDown) continue;
      rulesFor(defs, c).forEach((r, idx) => {
        if (r.kind !== 'when' || r.trigger !== trigger) return;
        s.pending = s.pending || [];
        if (s.pending.length >= 30) return;
        const extra = ctxFor(c) || {};
        s.pending.push({ n: (s.pendSeq = (s.pendSeq || 0) + 1), iid: c.iid, def: c.def, owner: c.owner, rule: idx,
          here: extra.here !== undefined ? extra.here : laneOf(c), hidden: ['hand', 'deck', 'stars'].includes(zoneKind(c.zone)) });
      });
    }
  }
  const boardCardsOf = (s, pid) => Object.values(s.cards).filter(c => inPlay(c) && (!pid || c.owner === pid));
  const fireBoard = (s, trigger, pid, ctxFor) => fire(s, trigger, boardCardsOf(s, pid), ctxFor);

  function condOk(s, defs, cond, ctx) {
    if (cond.not) return !condOk(s, defs, cond.not, ctx);
    if (cond.is === 'race') return s.phase === 'race';
    if (cond.is === 'ramp') return s.phase === 'ramp';
    if (cond.is === 'contested') return !!ctx.here && contestedLanes(s).includes(ctx.here);
    if (cond.is === 'holdHere') {
      if (!ctx.here || ctx.here === 'race') return false;
      const owners = new Set((s.zones['lane:' + ctx.here] || []).map(i => s.cards[i]).filter(c => c && !c.attachedTo).map(c => c.owner));
      return owners.size === 1 && owners.has(ctx.owner);
    }
    const left = cond.left.fans ? s.players[ctx.owner].fans : cond.left.hand ? (s.zones[`${ctx.owner}:hand`] || []).length : numVal(s, defs, cond.left, ctx);
    return CMP[cond.op](left, numVal(s, defs, cond.right, ctx));
  }

  // Where a code action sends a card.
  function codeDest(s, c, dest, ctx) {
    if (dest === 'here') return ctx.here || null;
    if (dest === 'other lane') { const l = laneOf(c); return l === 'mini0' ? 'mini1' : l === 'mini1' ? 'mini0' : pickN(s, ['mini0', 'mini1'], 1)[0]; }
    if (dest === 'random lane') {
      if (s.phase === 'race') return 'race';
      // During Ramps, units move between the mini lanes.
      const l = laneOf(c);
      const opts = ['mini0', 'mini1'].filter(x => x !== l);
      return pickN(s, opts, 1)[0];
    }
    return dest;
  }

  // Run one rule's actions. Returns what happened, for the log.
  function runActs(s, acts, ctx) {
    const defs = s.defs;
    const done = [];
    const nm = iid => cardName(s, iid, false);
    for (const a of acts) {
      if (a.cond && !condOk(s, defs, a.cond, ctx)) { done.push('(condition not met)'); continue; }
      try {
        switch (a.verb) {
          case 'move': {
            const list = selectPick(s, defs, a.sel, ctx);
            const moved = [];
            for (const iid of list) {
              const c = s.cards[iid];
              const to = codeDest(s, c, a.dest, ctx);
              if (!to || !c) continue;
              const n0 = nm(iid);
              moveCard(s, iid, to);
              moved.push(`${n0} → ${({ base: 'base', hand: 'hand', trash: 'trash', race: 'Race lane', 'deck-top': 'deck', 'deck-bottom': 'deck' })[to] || LANE_LABEL[to] || to}`);
            }
            done.push(moved.length ? 'moved ' + moved.join(', ') : 'nothing to move');
            break;
          }
          case 'conjure': {
            const n = Math.min(10, numVal(s, defs, a.count, ctx));
            const f = a.filter;
            const src = defs[ctx.def] || {};
            const leader = (s.zones[`${ctx.owner}:leader`] || [])[0];
            const leaderId = leader && s.cards[leader] ? s.cards[leader].def : null;
            const pool = Object.values(defs).filter(d => {
              if (!d || d.card_type === 'star' || d.card_type === 'superhorse' || Cards.isToken(d)) return false;
              const sig = f.signature;
              if (sig === 'no' ? !!d.signature_of : !d.signature_of) return false;
              if (sig === 'color' && !(d.types || []).some(t => (src.types || []).includes(t))) return false;
              if (sig === 'mine' && leaderId && d.signature_of !== leaderId) return false;
              if (f.kinds.length && !f.kinds.some(k => kindOk(d, {}, k))) return false;
              if (f.colors.length && !(d.types || []).some(t => f.colors.includes(t))) return false;
              if (f.flags.includes('champion') && !Cards.isChampion(d)) return false;
              for (const t of f.tags) if (!(d.tags || []).includes(t)) return false;
              for (const k of f.keywords) if (!(d.keywords || []).some(x => x === k || Cards.kwSlug(x) === Cards.kwSlug(k))) return false;
              for (const m of f.cmp) if (!CMP[m.op](Number(d[m.field === 'power' ? 'power' : 'energy'] || 0), numVal(s, defs, m.val, ctx))) return false;
              return true;
            });
            if (!pool.length) { done.push('no card fits that conjure'); break; }
            const made = [];
            for (let i = 0; i < n; i++) {
              const d = pool[Math.floor(rand(s) * pool.length)];
              const iid = addInstance(s, d.id, ctx.owner, null);
              s.cards[iid].conjured = true;
              place(s, iid, `${ctx.owner}:hand`);
              const to = codeDest(s, s.cards[iid], a.dest, ctx);
              if (to && to !== 'hand') moveCard(s, iid, to);
              made.push(d.name);
            }
            const secret = a.dest === 'hand' || a.dest.startsWith('deck');
            done.push(`conjured ${secret ? `${made.length} card${made.length > 1 ? 's' : ''}` : made.join(', ')}${a.dest === 'hand' ? ' into their hand' : ''}`);
            fireBoard(s, 'i conjure', ctx.owner);
            break;
          }
          case 'create': {
            const want = a.token.toLowerCase();
            const def = Object.values(defs).find(d => d && Cards.isToken(d) && (d.name.toLowerCase() === want || d.id === want || d.name.toLowerCase().replace(/s$/, '') === want));
            if (!def) { done.push(`no token called "${a.token}"`); break; }
            const n = Math.max(1, Math.min(10, numVal(s, defs, a.count, ctx)));
            let k = 0;
            for (let i = 0; i < n; i++) {
              const iid = addInstance(s, def.id, ctx.owner, null);
              s.cards[iid].token = true;
              place(s, iid, `${ctx.owner}:hand`);
              const to = codeDest(s, s.cards[iid], a.dest, ctx) || 'base';
              moveCard(s, iid, BOARD.includes(to) || LANES.includes(to) ? to : 'base', { enterReady: a.ready });
              k++;
            }
            done.push(`created ${k} ${def.name} token${k > 1 ? 's' : ''}`);
            break;
          }
          case 'draw': { let g = 0; const n = numVal(s, defs, a.count, ctx); for (let i = 0; i < n; i++) if (drawOne(s, ctx.owner)) g++; done.push(`drew ${g}`); break; }
          case 'discard': {
            const list = pickN(s, s.zones[`${ctx.owner}:hand`] || [], numVal(s, defs, a.count, ctx));
            const names = list.map(nm);
            for (const iid of list) moveCard(s, iid, 'trash');
            done.push(list.length ? `discarded ${names.join(', ')}` : 'nothing to discard');
            break;
          }
          case 'channel': {
            const stars = s.zones[`${ctx.owner}:stars`];
            let g = 0;
            for (let i = 0; i < numVal(s, defs, a.count, ctx) && stars.length; i++) { const iid = stars.shift(); s.cards[iid].exhausted = false; place(s, iid, `${ctx.owner}:pool`); g++; }
            done.push(`channeled ${g} Star${g === 1 ? '' : 's'}`);
            break;
          }
          case 'fans': {
            const n = numVal(s, defs, a.count, ctx) * a.sign;
            const who = a.who === 'me' ? [ctx.owner] : s.order.filter(p => p !== ctx.owner && !s.players[p].out);
            for (const p of who) s.players[p].fans += n;
            done.push(a.who === 'me' ? `${n >= 0 ? '+' : ''}${n} fans` : `each enemy ${n >= 0 ? '+' : ''}${n} fans`);
            checkWinner(s);
            break;
          }
          case 'might': case 'tempMight': case 'damage': case 'heal': case 'exhaust': case 'ready': case 'trash': case 'banish': {
            const list = selectPick(s, defs, a.sel, ctx);
            const names = list.map(nm);
            for (const iid of list) {
              const c = s.cards[iid];
              if (!c) continue;
              if (a.verb === 'might') c.might = (c.might || 0) + a.delta;
              else if (a.verb === 'tempMight') c.tmp = (c.tmp || 0) + a.delta;
              else if (a.verb === 'damage') c.dmg = (c.dmg || 0) + numVal(s, defs, a.count, ctx);
              else if (a.verb === 'heal') c.dmg = 0;
              else if (a.verb === 'exhaust') c.exhausted = true;
              else if (a.verb === 'ready') c.exhausted = false;
              else moveCard(s, iid, a.verb === 'trash' ? 'trash' : 'banish');
            }
            const what = { might: `${a.delta > 0 ? '+' : ''}${a.delta} might to`, tempMight: `${a.delta > 0 ? '+' : ''}${a.delta} temp might to`, damage: `${numVal(s, defs, a.count, ctx)} damage to`, heal: 'healed', exhaust: 'exhausted', ready: 'readied', trash: 'trashed', banish: 'banished' }[a.verb];
            done.push(names.length ? `${what} ${names.join(', ')}` : `no card to ${a.verb === 'tempMight' ? 'boost' : a.verb}`);
            break;
          }
          case 'revealHand': s.players[ctx.owner].revealHand = true; done.push('revealed their hand'); break;
          default: done.push(`(unknown action ${a.verb})`);
        }
      } catch (e) {
        done.push(`(${a.verb} failed: ${e.message})`);
      }
    }
    return done.join('; ');
  }

  // What a pending effect says (for the prompt).
  function pendingText(s, defs, p) {
    const def = defs[p.def];
    const r = rulesFor(defs, { def: p.def })[p.rule];
    return { name: def ? def.name : 'A card', text: r ? CardCode.explain(r) : '(this rule changed)' };
  }

  // Start of every Ramp: set up, then the first player's Units step begins.
  function startOfRamp(s) {
    rampSetup(s);
    fireBoard(s, 'ramp starts');
    unitsStepBegins(s, s.order[s.rampFirst]);
  }

  // A player's Units (or Units & tricks) step begins: a pending showdown
  // against them starts now; otherwise they score their held lanes.
  function unitsStepBegins(s, pid) {
    if (s.showdown && !s.showdown.active && s.phase === 'ramp' && pid !== s.showdown.pid) {
      s.showdown.active = true;
      log(s, null, `SHOWDOWN! ${nameOf(s, s.showdown.pid)} goes for the win (${(s.showdown.lanes || [s.showdown.lane]).map(l => LANE_LABEL[l]).join(' and ')}). Fight it out, then press who won the showdown.`);
    }
    scoreHolds(s, pid);
    fireBoard(s, 'my units step', pid);
  }

  // Both players ready everything, channel Stars, draw 1.
  function rampSetup(s) {
    if (G().FLOAT_CLEARS_EACH_RAMP !== false) for (const pid of s.order) if (s.players[pid].float) s.players[pid].float = { energy: 0, power: {} };
    if (G().AUTO_START_OF_RAMP === false) return;
    const notes = [];
    for (const pid of s.order) {
      for (const c of Object.values(s.cards)) {
        if (c.owner === pid && c.exhausted && BOARD.includes(zoneKind(c.zone))) c.exhausted = false;
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
    const second = s.order[(s.rampFirst + 1) % N(s)];
    const r = `Ramp ${s.ramp} of ${RAMPS()}`;
    if (isMulti(s) && s.phase === 'ramp' && s.step < CHECK(s)) {
      const st = stepInfo(s);
      const nm = nameOf(s, st.who);
      return st.kind === 'units'
        ? { title: `${r} · Units`, short: 'Units', who: st.who, hint: `${nm} plays units.` }
        : { title: `${r} · Tricks`, short: 'Tricks', who: st.who, hint: `${nm} plays tricks.${s.step === CHECK(s) - N(s) ? ' Face-down cards were revealed.' : ''}` };
    }
    if (s.phase === 'mulligan') return { title: 'Mulligan', short: 'Mulligan', who: null, hint: 'Look at your starting hand. Keep it, or shuffle it back and draw a new one (once).' };
    if (s.phase === 'race') return { title: 'Race', short: 'Race', who: null, hint: `The mini lanes are one lane now. Assign might as combat damage to the other player's units. Reaction! and Duel cards can be played. If only your units are left at the end, gain +${G().RACE_FANS} fans.` };
    switch (s.step) {
      case 0: return { title: `${r} · Units`, short: 'Units', who: first, hint: `${nameOf(s, first)} plays units.` };
      case 1: return { title: `${r} · Units & tricks`, short: 'Units & tricks', who: second, hint: `${nameOf(s, second)} plays units and tricks.` };
      case 2: return { title: `${r} · Tricks`, short: 'Tricks', who: first, hint: `${nameOf(s, first)} plays tricks. Reveal In the Shadows cards now.` };
      default: {
        const last = s.ramp >= RAMPS();
        return { title: last ? 'End of Ramp · Fight?' : `After Ramp ${s.ramp} · Fight?`, short: 'Fight?', who: null,
          hint: isMulti(s)
            ? `A mini lane is contested. Everyone secretly chooses Fight or Refuse. If two or more choose Fight, they fight; if only one does, they get +${G().MULTI_LONE_FIGHT_FANS ?? 50} fans. Then ${last ? 'the Race begins' : `Ramp ${s.ramp + 1} begins`}.`
            : `A mini lane is contested. Each player secretly chooses Fight or Refuse (refusing costs ${G().REFUSE_FIGHT_FANS ?? 50} fans). Then ${last ? 'the Race begins' : `Ramp ${s.ramp + 1} begins`}.` };
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
    // A "turn" belongs to the player who plays units first in a Ramp, and
    // lasts until the next Units step (so the last one includes the Race).
    const turns = [];
    for (let r = 1; r <= RAMPS(); r++) {
      const n = N(s);
      const firstIdx = (((s.rampFirst + (r - s.ramp)) % n) + n) % n;
      turns.push({ start: segs.length, who: s.order[firstIdx], n: (s.round - 1) * RAMPS() + r });
      for (let i = 0; i < CHECK(s); i++) {
        const st = stepInfo(s, i, firstIdx);
        const label = { units: 'Units', unitsTricks: 'Units & tricks', tricks: 'Tricks' }[st.kind];
        segs.push({ group: `Ramp ${r}`, label, kind: st.kind, who: st.who, key: `r${r}s${i}` });
      }
      if (isCheckpoint(s, r)) segs.push({ group: r === RAMPS() ? 'End' : 'Fight', label: 'Fight?', kind: 'check', who: null, key: `r${r}s${CHECK(s)}` });
    }
    segs.push({ group: 'Race', label: 'Race', who: null, key: 'race' });
    turns.forEach((t, i) => { t.end = i < turns.length - 1 ? turns[i + 1].start - 1 : segs.length - 1; });
    const key = s.phase === 'mulligan' ? 'mull' : s.phase === 'race' ? 'race' : `r${s.ramp}s${Math.min(s.step, CHECK(s))}`;
    index = Math.max(0, segs.findIndex(x => x.key === key));
    return { segs, index, turns };
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
      if (verb === 'played' && !opts.faceDown && s.cards[iid]) fire(s, 'played', [s.cards[iid]]);
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

    // Settle the showdown: if the challenger wins, they get the held fans (and usually the match).
    showdownResult(s, me, won) {
      const sd = s.showdown;
      if (!sd) throw new Error('There is no showdown.');
      s.showdown = null;
      if (won) {
        s.players[sd.pid].fans += sd.pts;
        log(s, me, `marked the showdown: ${nameOf(s, sd.pid)} wins it (+${sd.pts} fans).`);
        checkWinner(s);
      } else log(s, me, `marked the showdown: ${nameOf(s, sd.pid)} failed. No fans.`);
      return null;
    },

    // Dice roll from the sidebar. The numbers are rolled in the browser and
    // passed in, so both players see the same result.
    rollDice(s, me, sides, results) {
      sides = Math.max(2, Math.min(100, Number(sides) || 6));
      results = (results || []).slice(0, 10).map(n => Math.max(1, Math.min(sides, Number(n) || 1)));
      if (!results.length) throw new Error('Roll at least one die.');
      s.rollSeq = (s.rollSeq || 0) + 1;
      s.lastRoll = { n: s.rollSeq, by: me, sides, results };
      const total = results.reduce((a, b) => a + b, 0);
      return `rolled ${results.length}d${sides}: ${results.join(', ')}${results.length > 1 ? ` (total ${total})` : ''}`;
    },

    // Several actions at once (multi-select). Ones that don't apply are skipped.
    batch(s, me, list) {
      const texts = [];
      let skipped = 0;
      for (const [name, ...args] of list || []) {
        if (!A[name] || ['batch', 'undo', 'concede'].includes(name)) { skipped++; continue; }
        try { const t = A[name](s, me, ...args); if (t) texts.push(t); } catch (e) { skipped++; }
      }
      if (!texts.length) throw new Error('None of those could be done.');
      return texts.join('; ') + (skipped ? ` (${skipped} skipped)` : '');
    },

    // Floating Energy / Power: resources you've made but not spent yet.
    floatAdj(s, me, kind, type, d) {
      const p = s.players[me];
      p.float = p.float || { energy: 0, power: {} };
      if (kind === 'energy') p.float.energy = Math.max(0, (p.float.energy || 0) + d);
      else p.float.power[type] = Math.max(0, (p.float.power[type] || 0) + d);
      return null;
    },
    floatClear(s, me) { s.players[me].float = { energy: 0, power: {} }; return null; },

    // Trash → bottom of your deck, shuffled (Stars go back under your Star deck).
    recycleTrash(s, me) {
      const list = U.shuffle([...(s.zones[`${me}:trash`] || [])]);
      if (!list.length) throw new Error('Your trash is empty.');
      for (const iid of list) moveCard(s, iid, s.defs[s.cards[iid].def] && s.defs[s.cards[iid].def].card_type === 'star' ? 'stars-bottom' : 'deck-bottom');
      return `recycled their trash (${list.length} card${list.length > 1 ? 's' : ''}) to the bottom of their deck`;
    },

    // Exhaust n of your ready Stars at once (for paying energy).
    payStars(s, me, n) {
      const ready = (s.zones[`${me}:pool`] || []).map(i => s.cards[i]).filter(c => !c.exhausted && !c.mask);
      if (ready.length < n) throw new Error(`You only have ${ready.length} ready Star${ready.length === 1 ? '' : 's'}.`);
      for (const c of ready.slice(0, n)) c.exhausted = true;
      return `exhausted ${n} Star${n > 1 ? 's' : ''}`;
    },

    readyStars(s, me) {
      let n = 0;
      for (const i of s.zones[`${me}:pool`] || []) { const c = s.cards[i]; if (c.exhausted && !c.mask) { c.exhausted = false; n++; } }
      return `readied ${n} Star${n === 1 ? '' : 's'}`;
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
      return `${d > 0 ? 'gave +' + d : 'gave ' + d} temporary might to ${cardName(s, iid)} (now ${c.tmp >= 0 ? '+' : ''}${c.tmp})`;
    },

    banish(s, me, iid) {
      const c = s.cards[iid];
      const nm = cardName(s, iid, false);
      // remove it from the chain too, if it's there
      const ci = s.chain.findIndex(x => x.iid === iid);
      if (ci >= 0) { s.chain.splice(ci, 1); s.priority = s.chain.length ? nextPlayer(s, s.chain[s.chain.length - 1].by) : null; }
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
      if (!c.faceDown && inPlay(c)) fire(s, 'revealed', [c]);
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
      if (d0 && d0.card_type === 'trick' && !opts.faceDown) fire(s, 'enemy trick', boardCardsOf(s).filter(x => x.owner !== me));
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
        s.priority = nextPlayer(s, me);
        return `${responding ? 'responded with' : 'played'} ${cardName(s, iid, false)} (${chainDestText(s, s.chain[s.chain.length - 1])})`;
      }
      detachFromZone(s, iid);
      resetCard(c);
      place(s, iid, 'shared:chain');
      s.chain.push({ n: ++s.chainSeq, kind: 'play', iid, by: me, dest: dest || null, attachTo: opts.attachTo || null, from });
      s.priority = nextPlayer(s, me);
      return `${responding ? 'responded with' : 'played'} ${cardName(s, iid, false)} (${chainDestText(s, s.chain[s.chain.length - 1])})`;
    },

    ability(s, me, iid) {
      const c = s.cards[iid];
      if (!BOARD.includes(zoneKind(c.zone))) throw new Error('Only cards in play can use abilities.');
      const responding = s.chain.length > 0;
      s.chain.push({ n: ++s.chainSeq, kind: 'ability', iid, by: me });
      s.priority = nextPlayer(s, me);
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
        if (s.cards[item.iid]) fire(s, 'played', [s.cards[item.iid]]);
      } else {
        const nm = cardName(s, item.iid, false);
        const target = item.attachTo && s.cards[item.attachTo];
        if (target && BOARD.includes(zoneKind(target.zone))) A.attach(s, item.by, item.iid, item.attachTo);
        else moveCard(s, item.iid, item.dest && item.dest !== 'attach' ? item.dest : 'base');
        text = `resolved ${nm}`;
        if (s.cards[item.iid]) fire(s, 'played', [s.cards[item.iid]], () => ({ here: item.dest && LANES.includes(item.dest) ? item.dest : laneOf(s.cards[item.iid]) }));
      }
      s.priority = s.chain.length ? nextPlayer(s, s.chain[s.chain.length - 1].by) : null;
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
      s.priority = s.chain.length ? nextPlayer(s, s.chain[s.chain.length - 1].by) : null;
      return text;
    },

    takeBack(s, me, n) {
      const i = s.chain.findIndex(x => x.n === n);
      const item = s.chain[i];
      if (!item || item.by !== me) throw new Error('You can only take back your own play.');
      if (i !== s.chain.length - 1) throw new Error('Something was played on top of it. Resolve or counter that first.');
      s.chain.pop();
      if (item.kind === 'play' || item.kind === 'unit') moveCard(s, item.iid, item.from === 'champion' ? 'champion' : 'hand');
      s.priority = s.chain.length ? nextPlayer(s, s.chain[s.chain.length - 1].by) : null;
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

    give(s, me, iid, toPid) {
      const c = s.cards[iid];
      if (c.token) throw new Error("Tokens can't go to a hand. Trash it instead.");
      const to = toPid && s.players[toPid] && toPid !== c.owner ? toPid : nextPlayer(s, c.owner);
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
      fireBoard(s, 'i conjure', me);
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
      fireBoard(s, 'i conjure', me);
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
      if (s.phase === 'mulligan') throw new Error('Everyone needs to keep or mulligan first.');
      if (s.phase !== 'ramp' || s.step >= CHECK(s)) throw new Error('Use the buttons for the fight check or the Race.');
      if (s.step < CHECK(s) - 1) {
        s.step++;
        const t = rampText(s);
        log(s, me, `passed. Now: ${t.title} (${nameOf(s, t.who)})`);
        const st = stepInfo(s);
        if (st.kind === 'units' || st.kind === 'unitsTricks') unitsStepBegins(s, st.who);
        if (s.step === firstTricksStep(s)) revealFaceDown(s);
        if (st.kind === 'tricks' || st.kind === 'unitsTricks') fireBoard(s, 'my tricks step', st.who);
        return null;
      }
      log(s, me, 'passed.');
      if (isCheckpoint(s, s.ramp)) enterCheckpoint(s);
      else leaveCheckpoint(s);
      return null;
    },

    // Secret choice at a fight check. The other player only sees that you chose.
    fightChoice(s, me, choice) {
      if (s.step !== CHECK(s) || !s.fight) throw new Error('There is no fight check right now.');
      if (s.fight.result) throw new Error('Everyone already chose.');
      s.fight.choices[me] = choice === 'fight' ? 'fight' : 'refuse';
      if (!s.order.every(pid => s.fight.choices[pid] || (s.players[pid] && s.players[pid].out))) return 'made their choice';
      log(s, me, 'made their choice');
      if (isMulti(s)) {
        // 3–4 players: whoever chose Fight fights. A lone fighter gets fans instead.
        const fighters = s.order.filter(pid => s.fight.choices[pid] === 'fight');
        const bonus = G().MULTI_LONE_FIGHT_FANS ?? 50;
        if (fighters.length >= 2) {
          s.fight.result = 'fight';
          s.fight.fighters = fighters;
          s.miniFight = true;
          const out = s.order.filter(pid => !fighters.includes(pid));
          log(s, null, `${fighters.map(p => nameOf(s, p)).join(', ')} fight in the mini lanes!${out.length ? ` ${out.map(p => nameOf(s, p)).join(', ')} sit${out.length > 1 ? '' : 's'} out.` : ''}`);
        } else if (fighters.length === 1) {
          s.fight.result = 'refused';
          s.players[fighters[0]].fans += bonus;
          log(s, null, `Only ${nameOf(s, fighters[0])} wanted to fight: +${bonus} fans. No fight.`);
        } else {
          s.fight.result = 'refused';
          log(s, null, 'Nobody wanted to fight.');
        }
        checkWinner(s);
        return null;
      }
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
      if (s.step !== CHECK(s)) throw new Error('Nothing to continue from.');
      if (s.fight && !s.fight.result) throw new Error('Everyone chooses Fight or Refuse first.');
      log(s, me, s.ramp >= RAMPS() ? 'began the Race.' : `moved on to Ramp ${s.ramp + 1}.`);
      leaveCheckpoint(s, true);
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
      fireBoard(s, 'race ends');
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
      s.phase = 'ramp';
      s.step = 0;
      s.ramp = 1;
      s.round++;
      s.rampFirst = (s.rampFirst + 1) % N(s);
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

    // ----- card code -----
    // "Do it" on a card's triggered effect.
    resolveEffect(s, me, n) {
      const i = (s.pending || []).findIndex(p => p.n === n);
      if (i < 0) throw new Error('That effect is no longer waiting.');
      const p = s.pending[i];
      if (p.owner !== me && !(s.players[p.owner] && s.players[p.owner].out)) throw new Error(`Only ${nameOf(s, p.owner)} can decide on that effect.`);
      s.pending.splice(i, 1);
      const r = rulesFor(s.defs, { def: p.def })[p.rule];
      if (!r || !r.acts) return `skipped an effect that no longer exists`;
      const res = runActs(s, r.acts, { src: s.cards[p.iid] ? p.iid : null, owner: p.owner, here: p.here, def: p.def });
      return `used ${(s.defs[p.def] || {}).name || 'a card'}'s effect: ${res}`;
    },
    skipEffect(s, me, n) {
      const i = (s.pending || []).findIndex(p => p.n === n);
      if (i < 0) throw new Error('That effect is no longer waiting.');
      const p = s.pending[i];
      if (p.owner !== me && !(s.players[p.owner] && s.players[p.owner].out)) throw new Error(`Only ${nameOf(s, p.owner)} can decide on that effect.`);
      s.pending.splice(i, 1);
      return p.hidden ? 'skipped a card effect' : `skipped ${(s.defs[p.def] || {}).name || 'a card'}'s effect`;
    },
    // An "ability:" line from a card's code, used from its menu.
    codeAbility(s, me, iid, idx) {
      const c = s.cards[iid];
      if (!c || !inPlay(c)) throw new Error('Only cards in play can use abilities.');
      if (c.owner !== me) throw new Error("That's not your card.");
      const r = rulesFor(s.defs, c)[idx];
      if (!r || r.kind !== 'ability') throw new Error('That ability no longer exists.');
      const res = runActs(s, r.acts, { src: iid, owner: me, here: laneOf(c), def: c.def });
      return `used ${cardName(s, iid, false)}'s ability: ${res}`;
    },

    note(s, me, text) {
      return String(text).slice(0, 120);
    },

    concede(s, me) {
      if (!isMulti(s)) { s.winner = opp(s, me); return 'conceded'; }
      // 3–4 players: you're out; the last one standing wins.
      s.players[me].out = true;
      const left = s.order.filter(pid => !s.players[pid].out);
      if (left.length === 1) s.winner = left[0];
      return left.length === 1 ? `conceded. ${nameOf(s, left[0])} wins!` : 'conceded and is out of the match';
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
    if (state.phase === 'ramp' && state.step === CHECK(state) && !state.fight) state.fight = { choices: {}, result: null };
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
    buildRoomMatch, isMulti, nextPlayer, others, CHECK, stepInfo,
    activeMods, effCost, auraMight, pendingText, rulesFor, winTarget,
  };
})();
