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
    if (error) {
      if (/signature_of|champion_id/.test(error.message || '')) {
        throw new Error('Your database needs the latest update: in Supabase, open SQL Editor and run supabase/08-champion-signature.sql, then try again.');
      }
      if (/cards_keywords_check/.test(error.message || '')) {
        throw new Error('Your database needs the latest update to use custom keywords: in Supabase, open SQL Editor and run supabase/11-keywords.sql, then try again.');
      }
      if (/'code' column|cards\.code|column "code"|cards_code_length/.test(error.message || '')) {
        throw new Error('Your database needs the latest update to save card code: in Supabase, open SQL Editor and run supabase/14-card-code.sql, then try again.');
      }
      if (/play_anim/.test(error.message || '')) {
        throw new Error('Your database needs the latest update: in Supabase, open SQL Editor and run supabase/12-animations.sql, then try again.');
      }
      if (/sleeve/.test(error.message || '')) {
        throw new Error('Your database needs the latest update: in Supabase, open SQL Editor and run supabase/10-sleeves.sql, then try again.');
      }
      if (/is_token|type_count/.test(error.message || '')) {
        throw new Error('Your database needs the latest update: in Supabase, open SQL Editor and run supabase/09-tokens.sql, then try again.');
      }
      throw new Error(error.message);
    }
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
    const data = this.check(await this.sb.auth.signUp({ email, password, options: { data: { display_name: displayName },
      // If email confirmation is on, the link in the email comes back to this site.
      emailRedirectTo: location.origin + location.pathname } }));
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
    // Only sent when used, so older databases (before 08) keep working.
    if (card.signature_of !== undefined) row.signature_of = card.signature_of || null;
    if (card.is_token !== undefined) row.is_token = !!card.is_token;
    if (card.play_anim !== undefined) row.play_anim = card.play_anim || null;
    if (card.code !== undefined) row.code = (card.code || '').trim() || null;
    if (imageFile) row.image_url = await this.uploadImage(imageFile);
    if (card.id) return this.check(await this.sb.from('cards').update(row).eq('id', card.id).select().single());
    return this.check(await this.sb.from('cards').insert(row).select().single());
  }

  // ----- custom keywords (Keyword maker) -----
  async listKeywords() {
    const { data, error } = await this.sb.from('keywords').select('*').order('label');
    if (error) { if (/keywords/.test(error.message || '')) return []; throw new Error(error.message); }
    return data;
  }
  async saveKeyword(k) {
    const row = { label: k.label.trim(), help: (k.help || '').trim(), color: k.color || 'effect' };
    try {
      if (k.id) return this.check(await this.sb.from('keywords').update(row).eq('id', k.id).select().single());
      return this.check(await this.sb.from('keywords').insert({ ...row, slug: k.slug }).select().single());
    } catch (e) {
      if (/relation .*keywords|keywords.*does not exist|schema cache/i.test(e.message)) throw new Error('Your database needs the latest update: in Supabase, open SQL Editor and run supabase/11-keywords.sql, then try again.');
      if (/duplicate|unique/i.test(e.message)) throw new Error('A keyword with that name already exists.');
      throw e;
    }
  }
  async deleteKeyword(id) { this.check(await this.sb.from('keywords').delete().eq('id', id)); }

  // ----- play animations (Animation maker) -----
  async listAnimations() {
    const { data, error } = await this.sb.from('animations').select('*').order('name');
    if (error) { if (/animations/.test(error.message || '')) return []; throw new Error(error.message); }
    return data;
  }
  async saveAnimation(a) {
    // Code animations keep only their sound in config.
    const snd = a.config && a.config.sound ? { sound: a.config.sound } : null;
    const row = { name: a.name.trim(), kind: a.kind, config: a.kind === 'preset' ? a.config : snd, code: a.kind === 'code' ? a.code : null, duration: Number(a.duration) };
    try {
      if (a.id) return this.check(await this.sb.from('animations').update(row).eq('id', a.id).select().single());
      return this.check(await this.sb.from('animations').insert(row).select().single());
    } catch (e) {
      if (/relation .*animations|animations.*does not exist|schema cache/i.test(e.message)) throw new Error('Your database needs the latest update: in Supabase, open SQL Editor and run supabase/12-animations.sql, then try again.');
      throw e;
    }
  }
  async deleteAnimation(id) { this.check(await this.sb.from('animations').delete().eq('id', id)); }

  // Upload an image (card art, sleeves) to your folder in the card-art bucket.
  async uploadImage(file) {
    const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
    const path = `${this.me.id}/${U.uid()}.${ext}`;
    this.check(await this.sb.storage.from('card-art').upload(path, file, { contentType: file.type }));
    return this.sb.storage.from('card-art').getPublicUrl(path).data.publicUrl;
  }

  // Upload a sound file to your folder in the sounds bucket.
  async uploadSound(file) {
    const ext = (file.name.split('.').pop() || 'mp3').toLowerCase().replace(/[^a-z0-9]/g, '');
    const path = `${this.me.id}/${U.uid()}.${ext}`;
    const { error } = await this.sb.storage.from('sounds').upload(path, file, { contentType: file.type || 'audio/mpeg' });
    if (error) {
      if (/bucket not found/i.test(error.message || '')) throw new Error('Your database needs the latest update to upload sounds: in Supabase, open SQL Editor and run supabase/15-admin-settings.sql, then try again.');
      if (/mime|type/i.test(error.message || '')) throw new Error('That file type isn\'t allowed. Use an MP3, OGG, WAV, M4A or WebM sound.');
      if (/size|large/i.test(error.message || '')) throw new Error('That sound is too big (5 MB max).');
      throw new Error(error.message);
    }
    return this.sb.storage.from('sounds').getPublicUrl(path).data.publicUrl;
  }

  // ----- admin panel settings (sounds, card back) -----
  async getSettings() {
    const { data, error } = await this.sb.from('app_settings').select('key, value');
    if (error) { if (/app_settings/.test(error.message || '')) return {}; throw new Error(error.message); }
    return Object.fromEntries((data || []).map(r => [r.key, r.value]));
  }
  async saveSetting(key, value) {
    const { error } = await this.sb.from('app_settings').upsert({ key, value, updated_at: new Date().toISOString() });
    if (error) {
      if (/app_settings/.test(error.message || '')) throw new Error('Your database needs the latest update for the admin panel: in Supabase, open SQL Editor and run supabase/15-admin-settings.sql, then try again.');
      if (/row-level security/i.test(error.message || '')) throw new Error('Only admins can change these settings.');
      throw new Error(error.message);
    }
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
    const sigOf = Object.fromEntries(samples.filter(c => c.signature_of).map(c => [c.name.toLowerCase(), samples.find(x => x.id === c.signature_of).name.toLowerCase()]));
    const added = rows.length ? this.check(await this.sb.from('cards').insert(rows).select('id,name')) : [];
    // decks: remap sample ids → real ids (by name)
    const pool = await this.listCards();
    const idByName = Object.fromEntries(pool.map(c => [c.name.toLowerCase(), c.id]));
    const nameBySample = Object.fromEntries(samples.map(c => [c.id, c.name.toLowerCase()]));
    // Signature links (needs 08-champion-signature.sql; skipped if not run yet)
    try {
      for (const a of added) {
        const of = sigOf[a.name.toLowerCase()];
        if (of && idByName[of]) this.check(await this.sb.from('cards').update({ signature_of: idByName[of] }).eq('id', a.id));
      }
    } catch (e) { /* older database */ }
    const myDecks = (await this.listDecks()).filter(d => d.owner === this.me.id).map(d => d.name);
    let decks = 0;
    for (const d of DemoBackend.sampleDecks(samples)) {
      if (myDecks.includes(d.name)) continue;
      const cards = {};
      for (const [sid, n] of Object.entries(d.cards)) { const id = idByName[nameBySample[sid]]; if (id) cards[id] = n; }
      const deck = { name: d.name, leader_id: idByName[nameBySample[d.leader_id]] || null, cards, stars: d.stars };
      if (d.champion_id) deck.champion_id = idByName[nameBySample[d.champion_id]] || null;
      try { await this.saveDeck(deck); } catch (e) { delete deck.champion_id; await this.saveDeck(deck); }
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
    if (deck.champion_id !== undefined) row.champion_id = deck.champion_id || null;
    if (deck.sleeve !== undefined) row.sleeve = deck.sleeve || null;
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

  // ----- rooms (1v1v1 / 1v1v1v1) -----
  roomError(e) {
    if (/rooms|join_room|leave_room|schema cache/i.test(e.message || '')) return new Error('Your database needs the latest update for 1v1v1 / 1v1v1v1: in Supabase, open SQL Editor and run supabase/13-multiplayer.sql.');
    return new Error(e.message);
  }
  async listRooms() {
    const { data, error } = await this.sb.from('rooms').select('*').in('status', ['open', 'started'])
      .order('created_at', { ascending: false }).limit(30);
    if (error) { if (/rooms/.test(error.message || '')) return []; throw new Error(error.message); }
    return data;
  }
  async createRoom(size, deckId) {
    const { data, error } = await this.sb.from('rooms').insert({ size, members: [{ user: this.me.id, deck: deckId }] }).select().single();
    if (error) throw this.roomError(error);
    return data;
  }
  async joinRoom(id, deckId) {
    const { data, error } = await this.sb.rpc('join_room', { room: id, deck: deckId });
    if (error) throw this.roomError(error);
    return data;
  }
  async leaveRoom(id) {
    const { error } = await this.sb.rpc('leave_room', { room: id });
    if (error) throw this.roomError(error);
  }
  async markRoomStarted(id, matchId) {
    this.check(await this.sb.from('rooms').update({ status: 'started', match_id: matchId }).eq('id', id).eq('status', 'open'));
  }
  watchRooms(cb) {
    const refresh = async () => { try { cb(await this.listRooms()); } catch (e) { console.error(e); } };
    refresh();
    const ch = this.sb.channel('rooms-' + this.me.id)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms' }, refresh)
      .subscribe();
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
    const q = cols => this.sb.from('matches').select(cols).order('updated_at', { ascending: false }).limit(20);
    let r = await q('id,p1,p2,players,status,updated_at');
    if (r.error && /players/.test(r.error.message || '')) r = await q('id,p1,p2,status,updated_at'); // before 13-multiplayer.sql
    return this.check(r);
  }

  async createMatch({ p1, p2, players, state, defs }) {
    const row = { p1, p2, state };
    if (players && players.length > 2) row.players = players;
    let r = await this.sb.from('matches').insert(row).select('id').single();
    if (r.error && /players/.test(r.error.message || '')) throw new Error('Your database needs the latest update for 1v1v1 / 1v1v1v1: in Supabase, open SQL Editor and run supabase/13-multiplayer.sql, then try again.');
    const m = this.check(r);
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
