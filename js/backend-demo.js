// Offline demo backend: everything lives in memory in this browser tab.
// Used when config.js has no Supabase keys, so you can try the game first.
// A pretend friend ("Rival") accepts every challenge, and in a match you
// can switch which side you're viewing to play both players.
window.DemoBackend = class DemoBackend {
  constructor() {
    this.mode = 'demo';
    this.me = null;
    this.users = [
      { id: 'u-you', display_name: 'Player 1' },
      { id: 'u-rival', display_name: 'Rival' },
      { id: 'u-rival2', display_name: 'Rival 2' },
      { id: 'u-rival3', display_name: 'Rival 3' },
    ];
    this.cards = DemoBackend.samplePool();
    this.decks = DemoBackend.sampleDecks(this.cards);
    // Two sample play animations (demo only), tied to two sample cards.
    this.animations = [
      { id: 'anim-thunder', owner: 'u-rival', name: 'Thunder Corner', kind: 'preset', duration: 2.4,
        config: { effect: 'lightning', colorMode: 'card', intensity: 3, banner: 'Final corner!' } },
      { id: 'anim-namepop', owner: 'u-rival', name: 'Name Burst', kind: 'code', duration: 2.2, code: null },
    ];
    for (const c of this.cards) {
      if (c.name === 'Final Corner Kick') c.play_anim = 'anim-thunder';
      if (c.name === 'Steamroller') c.play_anim = 'anim-namepop';
    }
    this.challenges = [];
    this.matches = {};
    this.listeners = { challenges: new Set(), matches: {} };
  }

  async init() { return null; }

  async signIn(email, password, name) {
    this.me = { id: 'u-you', email: email || 'demo@local', name: name || 'Player 1', allowed: true, admin: true };
    this.users[0].display_name = this.me.name;
    return this.me;
  }
  async signUp(email, password, name) { return this.signIn(email, password, name); }
  async signOut() { this.me = null; }
  async joinWithCode() { throw new Error('Codes work once the site is online with Supabase.'); }

  // ----- guest codes (made here, but nobody else can join the demo) -----
  async createInvite(hostDeck, guestDeck) {
    const code = window.makeCode();
    this.invites = this.invites || [];
    this.invites.unshift({ code, host: this.me.id, host_deck: hostDeck, guest_deck: guestDeck,
      expires_at: new Date(Date.now() + 864e5).toISOString(), created_at: new Date().toISOString() });
    return code;
  }
  async listInvites() { return (this.invites || []).map(i => ({ ...i })); }
  async deleteInvite(code) { this.invites = (this.invites || []).filter(i => i.code !== code); }

  // ----- cards -----
  async listCards() { return this.cards.map(c => ({ ...c })); }
  async saveCard(card, imageFile) {
    const row = { ...card, name: card.name.trim(), energy: Number(card.energy || 0), power: Number(card.power || 0),
      might: Cards.hasMight(card) ? Number(card.might) : null };
    if (imageFile) row.image_url = URL.createObjectURL(imageFile);
    if (row.id) {
      const i = this.cards.findIndex(c => c.id === row.id);
      this.cards[i] = { ...this.cards[i], ...row };
      return this.cards[i];
    }
    row.id = U.uid();
    row.owner = this.me.id;
    row.created_at = new Date().toISOString();
    this.cards.push(row);
    return row;
  }
  async deleteCard(id) { this.cards = this.cards.filter(c => c.id !== id); }

  // ----- decks -----
  async listDecks() { return this.decks.map(d => U.clone(d)); }
  async getDeck(id) { const d = this.decks.find(x => x.id === id); return d ? U.clone(d) : null; }
  async uploadImage(file) { return URL.createObjectURL(file); }
  async listKeywords() { return (this.keywords || []).map(k => ({ ...k })); }
  async saveKeyword(k) {
    this.keywords = this.keywords || [];
    if (k.id) { const i = this.keywords.findIndex(x => x.id === k.id); this.keywords[i] = { ...this.keywords[i], label: k.label, help: k.help, color: k.color }; return this.keywords[i]; }
    if (this.keywords.some(x => x.slug === k.slug)) throw new Error('A keyword with that name already exists.');
    const row = { id: U.uid(), owner: this.me.id, slug: k.slug, label: k.label, help: k.help || '', color: k.color || 'effect' };
    this.keywords.push(row);
    return row;
  }
  async deleteKeyword(id) { this.keywords = (this.keywords || []).filter(k => k.id !== id); }
  async listAnimations() { return (this.animations || []).map(a => U.clone(a)); }
  async saveAnimation(a) {
    this.animations = this.animations || [];
    const row = { ...U.clone(a), name: a.name.trim() };
    if (row.id) { const i = this.animations.findIndex(x => x.id === row.id); this.animations[i] = { ...this.animations[i], ...row }; return this.animations[i]; }
    row.id = U.uid(); row.owner = this.me.id;
    this.animations.push(row);
    return row;
  }
  async deleteAnimation(id) {
    this.animations = (this.animations || []).filter(a => a.id !== id);
    for (const c of this.cards) if (c.play_anim === id) c.play_anim = null;
  }
  async saveDeck(deck) {
    const row = { ...U.clone(deck), updated_at: new Date().toISOString() };
    if (row.id) {
      const i = this.decks.findIndex(d => d.id === row.id);
      this.decks[i] = row;
    } else {
      row.id = U.uid();
      row.owner = this.me.id;
      this.decks.unshift(row);
    }
    return row;
  }
  async deleteDeck(id) { this.decks = this.decks.filter(d => d.id !== id); }

  // ----- players -----
  async listProfiles() { return this.users.map(u => ({ ...u })); }
  async renameMe(name) { this.me.name = name; this.users[0].display_name = name; }
  watchPresence(cb) { cb(new Set(this.users.map(u => u.id))); return () => {}; }

  // ----- challenges -----
  async listChallenges() { return this.challenges.filter(c => ['pending', 'accepted'].includes(c.status)).map(c => ({ ...c })); }
  emitChallenges() { this.listChallenges().then(list => this.listeners.challenges.forEach(cb => cb(list))); }
  watchChallenges(cb) {
    this.listeners.challenges.add(cb);
    this.listChallenges().then(cb);
    return () => this.listeners.challenges.delete(cb);
  }
  async sendChallenge(toUser, deckId) {
    const ch = { id: U.uid(), from_user: this.me.id, to_user: toUser, from_deck: deckId, status: 'pending', created_at: new Date().toISOString() };
    this.challenges.unshift(ch);
    this.emitChallenges();
    // The pretend friend accepts after a moment, using their own deck.
    setTimeout(async () => {
      if (ch.status !== 'pending') return;
      const rivalDeck = this.decks.find(d => d.owner === 'u-rival');
      const built = await Game.buildMatch(this, ch, rivalDeck.id);
      ch.match_id = await this.createMatch(built);
      ch.status = 'accepted';
      this.emitChallenges();
    }, 1200);
    return ch;
  }
  async updateChallenge(id, patch) {
    Object.assign(this.challenges.find(c => c.id === id), patch);
    this.emitChallenges();
  }

  // ----- matches -----
  async listMatches() {
    return Object.values(this.matches).map(m => ({ id: m.id, p1: m.p1, p2: m.p2, players: m.players || null, status: m.status, updated_at: m.updated_at }))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }
  async createMatch({ p1, p2, players, state, defs }) {
    const id = U.uid();
    this.matches[id] = { id, p1, p2, players: players || null, state, defs, version: 0, status: 'active', updated_at: new Date().toISOString() };
    return id;
  }

  // ----- rooms (1v1v1 / 1v1v1v1) -----
  // In the demo, pretend friends drop into your room one by one.
  async listRooms() { return (this.rooms || []).filter(r => ['open', 'started'].includes(r.status)).map(r => U.clone(r)); }
  emitRooms() { this.listRooms().then(list => (this.listeners.rooms || new Set()).forEach(cb => cb(list))); }
  watchRooms(cb) {
    (this.listeners.rooms = this.listeners.rooms || new Set()).add(cb);
    this.listRooms().then(cb);
    return () => this.listeners.rooms.delete(cb);
  }
  async createRoom(size, deckId) {
    this.rooms = this.rooms || [];
    const room = { id: U.uid(), host: this.me.id, size, members: [{ user: this.me.id, deck: deckId }], status: 'open', match_id: null, created_at: new Date().toISOString() };
    this.rooms.unshift(room);
    this.emitRooms();
    const bots = this.users.filter(u => u.id !== this.me.id).slice(0, size - 1);
    bots.forEach((u, i) => setTimeout(() => {
      if (room.status !== 'open' || room.members.length >= room.size) return;
      const deck = this.decks.find(d => d.owner === 'u-rival') || this.decks[0];
      room.members.push({ user: u.id, deck: deck.id });
      this.emitRooms();
    }, 900 + i * 900));
    return U.clone(room);
  }
  async joinRoom(id, deckId) {
    const r = (this.rooms || []).find(x => x.id === id);
    if (!r || r.status !== 'open') throw new Error('That room is no longer open.');
    if (!r.members.some(m => m.user === this.me.id)) {
      if (r.members.length >= r.size) throw new Error('That room is full.');
      r.members.push({ user: this.me.id, deck: deckId });
    }
    this.emitRooms();
    return U.clone(r);
  }
  async leaveRoom(id) {
    const r = (this.rooms || []).find(x => x.id === id);
    if (!r || r.status !== 'open') return;
    if (r.host === this.me.id) r.status = 'cancelled'; else r.members = r.members.filter(m => m.user !== this.me.id);
    this.emitRooms();
  }
  async markRoomStarted(id, matchId) {
    const r = (this.rooms || []).find(x => x.id === id);
    if (r && r.status === 'open') { r.status = 'started'; r.match_id = matchId; }
    this.emitRooms();
  }
  async getMatch(id) { return U.clone(this.matches[id]); }
  async commitMatch(id, fn) {
    const m = this.matches[id];
    const next = fn(U.clone(m.state));
    m.state = next;
    m.version++;
    m.status = next.winner ? 'finished' : 'active';
    m.updated_at = new Date().toISOString();
    const row = U.clone({ id, p1: m.p1, p2: m.p2, state: m.state, version: m.version, status: m.status });
    (this.listeners.matches[id] || new Set()).forEach(cb => cb(row));
    return row;
  }
  watchMatch(id, cb) {
    (this.listeners.matches[id] = this.listeners.matches[id] || new Set()).add(cb);
    return () => this.listeners.matches[id].delete(cb);
  }

  // ----- sample content (original names, placeholder art) -----
  static sampleCards() {
    const mk = (name, card_type, types, energy, power, might, keywords, effect) => ({
      id: 'sample-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), owner: 'u-rival', name, card_type, types, energy, power,
      might, keywords, effect, image_url: null, created_at: '2026-10-01T00:00:00Z',
    });
    return [
      mk('Northern Gale', 'superhorse', ['speed', 'wit'], 0, 0, 4, ['exhaust'], '[Exhaust>]: Move one of your units to the other mini lane.'),
      mk('Dawn Sprinter', 'uma', ['speed'], 1, 0, 2, ['showboat'], '[Showboat>]: If you hold a mini lane, draw a card.'),
      mk('Pocket Comet', 'uma', ['speed'], 2, 0, 3, ['interference'], ''),
      mk('Rail Hugger', 'uma', ['wit'], 2, 0, 2, ['exhaust'], '[Exhaust>]: Look at the top 2 cards of your deck and put them back in any order.'),
      mk('Quiet Thunder', 'uma', ['speed'], 4, 1, 5, [], 'If only your units are left at the end of a Race, gain an extra +50 fans.'),
      mk('Chess Clock', 'uma', ['wit'], 3, 0, 3, ['in-the-shadows'], '[In the Shadows] *(Played face-down.)* When revealed, exhaust an enemy unit.'),
      mk('Tailwind Filly', 'uma', ['speed', 'wit'], 1, 0, 1, ['reaction'], '[Reaction>]: Return this from the Lane to your hand.'),
      mk('Paddock Scout', 'uma', ['wit'], 1, 0, 1, ['showboat'], "[Showboat>]: Look at your opponent's hand."),
      mk('Slipstream', 'trick', ['speed'], 1, 0, null, ['reaction'], '[Reaction>]: Give a unit +2 {might} this Race.'),
      mk('Read the Pace', 'trick', ['wit'], 2, 0, null, ['reaction'], 'Counter a trick.'),
      mk('Final Corner Kick', 'trick', ['speed'], 2, 1, null, ['duel'], '[Duel>]: Deal 3 damage to a unit in the Lane.'),
      mk('Morning Workout', 'trick', ['speed'], 1, 0, null, [], 'Draw 2 cards, then trash 1 card from your hand.'),
      mk('Starting Gate Jitters', 'trick', ['wit'], 1, 0, null, [], 'Exhaust an enemy unit.'),
      mk('Stopwatch Coach', 'trainer', ['wit'], 2, 0, null, ['friendship', 'exhaust'], '[Friendship] Attached unit has +1 {might}. [Exhaust>]: Draw a card.'),
      mk('Photo Finish', 'trick', ['speed'], 0, 2, null, ['duel'], 'If both players have units left at the end of this Race, you gain +50 fans.'),

      mk('Granite Heart', 'superhorse', ['power', 'guts'], 0, 0, 5, [], 'When one of your units is still in the Lane at the end of a Race, give it +1 might.'),
      mk('Iron Mile', 'uma', ['guts'], 2, 0, 3, [], "This can't be moved by enemy tricks."),
      mk('Copper Bell', 'uma', ['power'], 1, 0, 2, ['showboat'], '[Showboat>]: Deal 1 damage to an enemy unit in this mini lane.'),
      mk('Mudlark', 'uma', ['guts'], 3, 0, 4, ['uma-roar'], '[Uma-Roar>]: Channel 1 {star}, exhausted. [Conjure>]: a {guts} Trick that costs {E1} or less.'),
      mk('Boulder Run', 'uma', ['power'], 5, 1, 7, [], ''),
      mk('Steamroller', 'uma', ['power'], 4, 0, 5, [], 'Takes 1 less damage from each source.'),
      mk('Heavy Track Specialist', 'uma', ['guts'], 2, 0, 3, [], '+2 might while in the Race lane.'),
      mk('Second Wind', 'trick', ['guts'], 1, 0, null, ['reaction'], 'Remove all damage from a unit.'),
      mk('Shoulder Check', 'trick', ['power'], 2, 0, null, ['duel'], 'Your unit deals damage equal to its might to an enemy unit.'),
      mk('Never Say Die', 'trick', ['guts'], 2, 0, null, ['reaction'], 'Prevent all damage to a unit this Race.'),
      mk('Bull Rush', 'trick', ['power'], 1, 0, null, [], 'Move an enemy unit to the other mini lane.'),
      mk('Grit Teeth', 'trick', ['guts'], 0, 1, null, [], 'Ready a unit.'),
      mk('Ringside Chant', 'trick', ['power'], 3, 0, null, ['conjure'], '[Conjure>]: a {power} Uma that costs {E2} or less, into your hand.'),
      mk('Bulldog Stride', 'uma', ['guts'], 1, 0, 2, [], ''),
      mk('Rainy Day', 'trick', ['wit'], 2, 0, null, ['environment'], '[Environment] Enemy units here have -1 {might}.'),
      mk('Heavy Going', 'trick', ['guts'], 1, 0, null, ['environment'], '[Environment] Your Guts units here have +1 {might}. Units here can\'t be moved by tricks.'),
      mk('Lucky Horseshoe', 'trainer', ['guts'], 1, 0, null, ['friendship'], '[Friendship] Attached unit has +2 {might}.'),
    ];
  }

  // The sample cards with rarity, subtitles, tags and conjure settings.
  static samplePool() {
    const rar = DemoBackend.rarities();
    const subs = { 'Quiet Thunder': 'Storm at the Finish', 'Boulder Run': 'Mountain of the Stretch', 'Northern Gale': 'Wind Over the Far Turn', 'Granite Heart': 'Unbreakable Pace' };
    const tags = {
      'Dawn Sprinter': ['front-runner'], 'Pocket Comet': ['front-runner'], 'Tailwind Filly': ['pace-chaser'],
      'Rail Hugger': ['pace-chaser'], 'Quiet Thunder': ['end-closer'], 'Chess Clock': ['end-closer'], 'Paddock Scout': ['pace-chaser'],
      'Iron Mile': ['long-runner'], 'Copper Bell': ['front-runner'], 'Mudlark': ['long-runner'], 'Boulder Run': ['end-closer'],
      'Steamroller': ['long-runner'], 'Heavy Track Specialist': ['long-runner'], 'Bulldog Stride': ['front-runner'],
    };
    const conj = {
      'Ringside Chant': { kind: 'uma', colors: ['power'], energyOp: 'le', energy: 2, dest: 'hand' },
      'Mudlark': { kind: 'trick', energyOp: 'le', energy: 1, colors: ['guts'], dest: 'hand' },
    };
    const sigs = { 'Photo Finish': 'Northern Gale', 'Ringside Chant': 'Granite Heart' };
    const idOf = n => 'sample-' + n.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return DemoBackend.sampleCards().map(c => ({
      signature_of: sigs[c.name] ? idOf(sigs[c.name]) : null,
      ...c, rarity: (rar[c.name] || ['common'])[0], full_art: !!(rar[c.name] || [])[1], subtitle: subs[c.name] || null,
      tags: tags[c.name] || [], conjure: conj[c.name] ? { ...Cards.CONJURE_DEFAULT, ...conj[c.name] } : null,
      keywords: conj[c.name] && !c.keywords.includes('conjure') ? [...c.keywords, 'conjure'] : c.keywords,
    }));
  }

  static rarities() {
    return {
      'Northern Gale': ['epic', true], 'Granite Heart': ['epic', true],
      'Quiet Thunder': ['epic', true], 'Boulder Run': ['epic', false],
      'Photo Finish': ['signature', true], 'Ringside Chant': ['signature', true],
      'Chess Clock': ['rare', false], 'Final Corner Kick': ['rare', false], 'Read the Pace': ['rare', false],
      'Never Say Die': ['rare', false], 'Steamroller': ['rare', false], 'Stopwatch Coach': ['uncommon', false],
      'Pocket Comet': ['uncommon', false], 'Rail Hugger': ['uncommon', false], 'Mudlark': ['uncommon', false],
      'Second Wind': ['uncommon', false], 'Lucky Horseshoe': ['uncommon', false],
    };
  }

  static sampleDecks(cards) {
    const build = (owner, name, leaderName, types, champName) => {
      const leaderId = cards.find(c => c.name === leaderName).id;
      const champ = cards.find(c => c.name === champName);
      const pool = cards.filter(c => c.card_type !== 'superhorse' && c.types.every(t => types.includes(t)) &&
        (!c.signature_of || c.signature_of === leaderId));
      const counts = {};
      let total = 0;
      pool.forEach((c, i) => {
        const n = i < pool.length - 1 ? 3 : 1;
        counts[c.id] = n;
        total += n;
      });
      // The Champion takes one of its 3 copies; Signature cards max 3 (they're all 3s or fewer).
      if (champ && counts[champ.id]) { counts[champ.id]--; total--; if (!counts[champ.id]) delete counts[champ.id]; }
      const target = 40 - (champ ? 1 : 0);
      const ids = Object.keys(counts);
      for (let i = ids.length - 1; total > target && i >= 0; i--) { counts[ids[i]]--; total--; if (!counts[ids[i]]) delete counts[ids[i]]; }
      return {
        id: 'deck-' + owner, owner, name, leader_id: leaderId, champion_id: champ ? champ.id : null, cards: counts,
        stars: { [types[0]]: 6, [types[1]]: 6 }, updated_at: '2026-10-01T00:00:00Z',
      };
    };
    return [
      build('u-you', 'Gale Tempo', 'Northern Gale', ['speed', 'wit'], 'Quiet Thunder'),
      build('u-rival', 'Granite Grind', 'Granite Heart', ['power', 'guts'], 'Boulder Run'),
    ];
  }
};
