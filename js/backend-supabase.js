// The real online backend: Supabase handles login, the whitelist,
// storage for card art, and live updates.
// 8-character code without look-alike letters (no O/0, I/1).
function makeCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, b => abc[b % abc.length]).join('');
}
window.makeCode = makeCode;

window.SupabaseBackend = class SupabaseBackend {
  constructor(url, key) {
    this.mode = 'online';
    this.sb = window.supabase.createClient(url, key);
    this.me = null;
    this.matchCache = {};
  }

  check({ data, error }) {
    if (error) throw new Error(error.message);
    return data;
  }

  async init() {
    const { data } = await this.sb.auth.getSession();
    if (!data.session) return null;
    return this.loadMe(data.session.user);
  }

  async loadMe(user) {
    const allowed = this.check(await this.sb.rpc('is_allowed'));
    let name = (user.user_metadata && user.user_metadata.display_name) || (user.email ? user.email.split('@')[0] : 'Guest');
    if (allowed) {
      const prof = this.check(await this.sb.from('profiles').select('*').eq('id', user.id).maybeSingle());
      if (prof) name = prof.display_name;
      else this.check(await this.sb.from('profiles').insert({ id: user.id, display_name: name.slice(0, 32) }));
    }
    let admin = false;
    if (allowed) { try { admin = !!this.check(await this.sb.rpc('is_admin')); } catch (e) { /* admins not set up yet */ } }
    this.me = { id: user.id, email: user.email || null, name, allowed, admin, guest: !!user.is_anonymous };
    return this.me;
  }

  async signIn(email, password) {
    const data = this.check(await this.sb.auth.signInWithPassword({ email, password }));
    return this.loadMe(data.user);
  }

  async signUp(email, password, displayName) {
    const data = this.check(await this.sb.auth.signUp({ email, password, options: { data: { display_name: displayName } } }));
    if (!data.session) return { needsConfirm: true };
    return this.loadMe(data.user);
  }

  // Guest entry: anonymous sign-in, then redeem the code on the server.
  async joinWithCode(code, name) {
    const auth = this.check(await this.sb.auth.signInAnonymously({ options: { data: { display_name: name } } }));
    try {
      const res = this.check(await this.sb.rpc('redeem_invite', { p_code: code, p_name: name }));
      const me = await this.loadMe(auth.user);
      return { me, challengeId: res.challenge_id, deckId: res.deck_id };
    } catch (e) {
      await this.sb.auth.signOut();
      this.me = null;
      throw e;
    }
  }

  // ----- guest codes -----
  async createInvite(hostDeck, guestDeck) {
    const code = makeCode();
    this.check(await this.sb.from('invites').insert({ code, host_deck: hostDeck, guest_deck: guestDeck }));
    return code;
  }

  async listInvites() {
    return this.check(await this.sb.from('invites').select('*').is('used_by', null)
      .gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }));
  }

  async deleteInvite(code) {
    this.check(await this.sb.from('invites').delete().eq('code', code));
  }

  async signOut() {
    await this.sb.auth.signOut();
    this.me = null;
  }

  // ----- cards -----
  async listCards() {
    return this.check(await this.sb.from('cards').select('*').order('created_at', { ascending: true }));
  }

  async saveCard(card, imageFile) {
    const row = {
      name: card.name.trim(), card_type: card.card_type, types: card.types, energy: Number(card.energy || 0),
      power: Number(card.power || 0), might: Cards.hasMight(card) ? Number(card.might) : null,
      keywords: card.keywords || [], effect: card.effect || '', image_url: card.image_url || null,
      rarity: card.rarity || 'common', full_art: !!card.full_art,
      subtitle: (card.subtitle || '').trim() || null,
      tags: card.tags || [],
      conjure: (card.keywords || []).includes('conjure') && card.conjure ? card.conjure : null,
    };
    if (imageFile) {
      const ext = (imageFile.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
      const path = `${this.me.id}/${U.uid()}.${ext}`;
      this.check(await this.sb.storage.from('card-art').upload(path, imageFile, { contentType: imageFile.type }));
      row.image_url = this.sb.storage.from('card-art').getPublicUrl(path).data.publicUrl;
    }
    if (card.id) return this.check(await this.sb.from('cards').update(row).eq('id', card.id).select().single());
    return this.check(await this.sb.from('cards').insert(row).select().single());
  }

  // Admin: add the sample cards + two sample decks to the real pool.
  // Cards whose name is already in the pool are skipped.
  async importSamples() {
    const existing = new Set((await this.listCards()).map(c => c.name.toLowerCase()));
    const samples = DemoBackend.samplePool();
    const rows = samples.filter(c => !existing.has(c.name.toLowerCase())).map(c => ({
      name: c.name, card_type: c.card_type, types: c.types, energy: c.energy, power: c.power, might: c.might,
      keywords: c.keywords, effect: c.effect, rarity: c.rarity, full_art: c.full_art, subtitle: c.subtitle,
      tags: c.tags, conjure: c.conjure,
    }));
    const added = rows.length ? this.check(await this.sb.from('cards').insert(rows).select('id,name')) : [];
    // decks: remap sample ids → real ids (by name)
    const pool = await this.listCards();
    const idByName = Object.fromEntries(pool.map(c => [c.name.toLowerCase(), c.id]));
    const nameBySample = Object.fromEntries(samples.map(c => [c.id, c.name.toLowerCase()]));
    const myDecks = (await this.listDecks()).filter(d => d.owner === this.me.id).map(d => d.name);
    let decks = 0;
    for (const d of DemoBackend.sampleDecks(samples)) {
      if (myDecks.includes(d.name)) continue;
      const cards = {};
      for (const [sid, n] of Object.entries(d.cards)) { const id = idByName[nameBySample[sid]]; if (id) cards[id] = n; }
      await this.saveDeck({ name: d.name, leader_id: idByName[nameBySample[d.leader_id]] || null, cards, stars: d.stars });
      decks++;
    }
    return { cards: added.length, skipped: samples.length - rows.length, decks };
  }

  async deleteCard(id) {
    this.check(await this.sb.from('cards').delete().eq('id', id));
  }

  // ----- decks -----
  async listDecks() {
    return this.check(await this.sb.from('decks').select('*').order('updated_at', { ascending: false }));
  }

  async getDeck(id) {
    return this.check(await this.sb.from('decks').select('*').eq('id', id).maybeSingle());
  }

  async saveDeck(deck) {
    const row = { name: deck.name, leader_id: deck.leader_id || null, cards: deck.cards, stars: deck.stars, updated_at: new Date().toISOString() };
    if (deck.id) return this.check(await this.sb.from('decks').update(row).eq('id', deck.id).select().single());
    return this.check(await this.sb.from('decks').insert(row).select().single());
  }

  async deleteDeck(id) {
    this.check(await this.sb.from('decks').delete().eq('id', id));
  }

  // ----- players -----
  async listProfiles() {
    return this.check(await this.sb.from('profiles').select('*').order('display_name'));
  }

  async renameMe(name) {
    this.check(await this.sb.from('profiles').update({ display_name: name }).eq('id', this.me.id));
    this.me.name = name;
  }

  // Calls cb(Set of online user ids) whenever someone comes or goes.
  watchPresence(cb) {
    const ch = this.sb.channel('lobby', { config: { presence: { key: this.me.id } } });
    ch.on('presence', { event: 'sync' }, () => cb(new Set(Object.keys(ch.presenceState()))))
      .subscribe(async status => { if (status === 'SUBSCRIBED') await ch.track({ name: this.me.name }); });
    return () => this.sb.removeChannel(ch);
  }

  // ----- challenges -----
  async listChallenges() {
    return this.check(await this.sb.from('challenges').select('*').in('status', ['pending', 'accepted'])
      .order('created_at', { ascending: false }).limit(30));
  }

  watchChallenges(cb) {
    const refresh = async () => { try { cb(await this.listChallenges()); } catch (e) { console.error(e); } };
    refresh();
    const ch = this.sb.channel('challenges-' + this.me.id)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'challenges' }, refresh)
      .subscribe();
    return () => this.sb.removeChannel(ch);
  }

  async sendChallenge(toUser, deckId) {
    return this.check(await this.sb.from('challenges').insert({ to_user: toUser, from_deck: deckId }).select().single());
  }

  async updateChallenge(id, patch) {
    this.check(await this.sb.from('challenges').update(patch).eq('id', id));
  }

  // ----- matches -----
  async listMatches() {
    return this.check(await this.sb.from('matches').select('id,p1,p2,status,updated_at')
      .order('updated_at', { ascending: false }).limit(20));
  }

  async createMatch({ p1, p2, state, defs }) {
    const m = this.check(await this.sb.from('matches').insert({ p1, p2, state }).select('id').single());
    this.check(await this.sb.from('match_defs').insert({ match_id: m.id, defs }));
    return m.id;
  }

  async getMatch(id) {
    const m = this.check(await this.sb.from('matches').select('*').eq('id', id).single());
    const d = this.check(await this.sb.from('match_defs').select('defs').eq('match_id', id).single());
    this.matchCache[id] = m;
    return { ...m, defs: d.defs };
  }

  // Applies fn(state) => newState, safely: if someone else changed the match
  // in the meantime, re-reads it and tries again on the fresh state.
  async commitMatch(id, fn) {
    for (let attempt = 0; attempt < 5; attempt++) {
      let cur = this.matchCache[id];
      if (!cur || attempt > 0) {
        cur = this.check(await this.sb.from('matches').select('*').eq('id', id).single());
        this.matchCache[id] = cur;
      }
      const next = fn(U.clone(cur.state));
      const status = next.winner ? 'finished' : 'active';
      const rows = this.check(await this.sb.from('matches')
        .update({ state: next, version: cur.version + 1, status, updated_at: new Date().toISOString() })
        .eq('id', id).eq('version', cur.version).select());
      if (rows.length) {
        this.matchCache[id] = rows[0];
        return rows[0];
      }
    }
    throw new Error('The table is busy. Try that again.');
  }

  watchMatch(id, cb) {
    const ch = this.sb.channel('match-' + id)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'matches', filter: 'id=eq.' + id }, payload => {
        const row = payload.new;
        const cur = this.matchCache[id];
        if (!cur || row.version > cur.version) {
          this.matchCache[id] = row;
          cb(row);
        }
      })
      .subscribe();
    // Safety net in case a live update is missed (e.g. laptop slept).
    const poll = setInterval(async () => {
      try {
        const row = this.check(await this.sb.from('matches').select('*').eq('id', id).single());
        const cur = this.matchCache[id];
        if (!cur || row.version > cur.version) { this.matchCache[id] = row; cb(row); }
      } catch (e) { /* offline for a moment */ }
    }, 15000);
    return () => { clearInterval(poll); this.sb.removeChannel(ch); };
  }
};
