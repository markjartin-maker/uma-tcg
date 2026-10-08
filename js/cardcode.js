// The card language: one rule per line, written in plain words.
//
//   while on board: enemy tricks cost +2
//   always: cards I conjure cost -1
//   when I hold: move me to random lane; conjure uma to here
//   when played: if race: draw 2
//   ability: trash random card in my hand; draw 2
//
// compile(text) → { rules, errors }. explain(rule) → plain English.
// The game (js/game.js) runs the rules; this file only reads them.
window.CardCode = (() => {
  // ---------- vocabulary ----------
  const COLORS = ['speed', 'stamina', 'power', 'guts', 'wit'];
  const KINDS = {
    uma: 'uma', umas: 'uma', unit: 'uma', units: 'uma',
    trick: 'trick', tricks: 'trick', spell: 'trick', spells: 'trick',
    trainer: 'trainer', trainers: 'trainer', gear: 'trainer',
    environment: 'environment', environments: 'environment',
    token: 'token', tokens: 'token',
    card: 'card', cards: 'card',
  };
  const PLURAL = new Set(['umas', 'units', 'tricks', 'spells', 'trainers', 'environments', 'tokens', 'cards']);
  const PLACES = { 'on board': 'board', 'in play': 'board', 'in lane': 'lane', 'in a lane': 'lane', 'in lanes': 'lane', 'in hand': 'hand', 'on base': 'base', 'in base': 'base', 'in race': 'race' };
  const TRIGGERS = [
    ['played', 'played', 'when this card is played'],
    ['revealed', 'revealed', 'when this card is revealed'],
    ['enters lane', 'enters lane', 'when this card enters a lane'],
    ['enters a lane', 'enters lane', null],
    ['i hold', 'hold', 'when you hold a mini lane (while this is in play)'],
    ['i hold a lane', 'hold', null],
    ['my units step', 'my units step', 'when your Units step begins'],
    ['my tricks step', 'my tricks step', 'when your Tricks step begins'],
    ['ramp starts', 'ramp starts', 'when a Ramp starts'],
    ['race starts', 'race starts', 'when the Race starts'],
    ['race ends', 'race ends', 'when a Race ends'],
    ['leaves play', 'leaves play', 'when this card leaves play'],
    ['drawn', 'drawn', 'when you draw this card'],
    ['i conjure', 'i conjure', 'when you conjure a card'],
    ['enemy plays a trick', 'enemy trick', 'when an enemy plays a trick'],
  ];
  const TRIGGER_TEXT = Object.fromEntries(TRIGGERS.filter(t => t[2]).map(t => [t[1], t[2]]));

  // ---------- tokenizer ----------
  // words, numbers, signed numbers (+2 / -1), comparison operators, ( ) x
  function tokenize(str) {
    const out = [];
    const re = /\s*(<=|>=|!=|==|=|<|>|[+-]\d+|\d+|\(|\)|,|[a-z][a-z0-9'_-]*|\S)/gy;
    let m;
    while ((m = re.exec(str)) && m[0].trim()) out.push(m[1]);
    return out;
  }

  class Stream {
    constructor(toks) { this.t = toks; this.i = 0; }
    peek(k = 0) { return this.t[this.i + k]; }
    next() { return this.t[this.i++]; }
    done() { return this.i >= this.t.length; }
    is(...words) { return words.every((w, k) => this.peek(k) === w); }
    eat(...words) { if (this.is(...words)) { this.i += words.length; return true; } return false; }
    expect(word, what) { if (!this.eat(word)) throw new Error(`expected "${word}"${what ? ' ' + what : ''}${this.peek() ? `, got "${this.peek()}"` : ''}`); }
    rest() { return this.t.slice(this.i).join(' '); }
  }

  const isNum = t => /^[+-]?\d+$/.test(t || '');
  const OPS = { '<=': 'le', '>=': 'ge', '<': 'lt', '>': 'gt', '=': 'eq', '==': 'eq', '!=': 'ne' };

  // number := N | count(SEL) | N x count(SEL) | count(SEL) x N
  function parseNumber(st) {
    let n;
    if (st.is('count')) { st.next(); st.expect('('); n = { count: parseSelector(st, { stop: [')'] }) }; st.expect(')'); }
    else if (isNum(st.peek())) n = { n: Math.abs(Number(st.next())) };
    else throw new Error(`expected a number${st.peek() ? `, got "${st.peek()}"` : ''}`);
    if (st.eat('x') || st.eat('*') || st.eat('times')) {
      const m = parseNumber(st);
      return { mul: [n, m] };
    }
    return n;
  }

  // Which cards. Stops at a word that starts the next part.
  const STOPS = new Set(['to', 'cost', 'costs', 'get', 'gets', 'have', 'has', 'might', ')', ',', 'into', 'and']);
  function parseSelector(st, { stop = [], noRel = false } = {}) {
    const sel = { quant: null, n: 1, rel: 'any', kinds: [], colors: [], where: null, tags: [], keywords: [], cmp: [], flags: [] };
    let plural = false, sawAny = false;
    const stopHere = () => st.done() || stop.includes(st.peek()) || /^[+-]\d+$/.test(st.peek()) || (STOPS.has(st.peek()) && !(st.peek() === 'cost' && OPS[st.peek(1)]));
    for (let guard = 0; guard < 40 && !stopHere(); guard++) {
      const w = st.peek();
      if (w === 'me' || w === 'this' || w === 'itself') { st.next(); st.eat('card'); sel.me = true; sawAny = true; continue; }
      if (w === 'a' || w === 'an' || w === 'the' || w === 'of') { st.next(); continue; }
      if (w === 'all' || w === 'every' || w === 'each') { st.next(); sel.quant = 'all'; continue; }
      if (w === 'random') { st.next(); sel.quant = 'random'; continue; }
      if (isNum(w) && !w.startsWith('+') && !w.startsWith('-') && st.peek(1) === 'random') { sel.n = Number(st.next()); st.next(); sel.quant = 'random'; continue; }
      if (!noRel && (w === 'my' || w === 'mine' || w === 'your' || w === 'friendly')) { st.next(); sel.rel = 'my'; continue; }
      if (!noRel && (w === 'enemy' || w === 'enemies' || w === "enemy's" || w === 'opponent' || w === "opponent's" || w === 'opposing' || w === 'their')) { st.next(); sel.rel = 'enemy'; if (w === 'enemies') { sel.kinds.push('card'); plural = true; } continue; }
      if (w === 'any') { st.next(); sel.rel = 'any'; continue; }
      if (COLORS.includes(w) && !(w === 'power' && st.peek(1) === 'cost')) { st.next(); sel.colors.push(w); continue; }
      if (KINDS[w]) { st.next(); sel.kinds.push(KINDS[w]); if (PLURAL.has(w)) plural = true; sawAny = true; continue; }
      if (w === 'conjured') { st.next(); sel.flags.push('conjured'); continue; }
      if (w === 'champion' || w === 'champions') { st.next(); sel.flags.push('champion'); continue; }
      if (w === 'signature' || w === 'signatures') { st.next(); sel.flags.push('signature'); continue; }
      if (w === 'exhausted' || w === 'ready' || w === 'damaged' || w === 'face-down') { st.next(); sel.flags.push(w); continue; }
      if (w === 'here') { st.next(); sel.where = 'here'; continue; }
      if (w === 'there') { st.next(); sel.where = 'here'; continue; }
      if (w === 'in' || w === 'on') {
        const two = `${w} ${st.peek(1)}`, three = `${w} ${st.peek(1)} ${st.peek(2)}`;
        if (PLACES[three]) { st.i += 3; sel.where = PLACES[three]; continue; }
        if (PLACES[two]) { st.i += 2; sel.where = PLACES[two]; continue; }
        if (two === 'in my' && st.peek(2) === 'hand') { st.i += 3; sel.where = 'hand'; sel.rel = 'my'; continue; }
        if (two === 'in my' && st.peek(2) === 'trash') { st.i += 3; sel.where = 'trash'; sel.rel = 'my'; continue; }
        if (two === 'in the' && st.peek(2) === 'race') { st.i += 3; sel.where = 'race'; continue; }
        break;
      }
      if (w === 'i' && st.peek(1) === 'conjure') { st.i += 2; sel.rel = 'my'; sel.flags.push('conjured'); continue; }
      if (w === 'that' || w === 'which' || w === 'with') { st.next(); continue; }
      if ((w === 'cost' || w === 'might' || w === 'power') && (OPS[st.peek(1)] || (w === 'power' && st.peek(1) === 'cost' && OPS[st.peek(2)]))) {
        st.next(); if (w === 'power') st.next();
        const op = OPS[st.next()];
        sel.cmp.push({ field: w === 'power' ? 'power' : w, op, val: parseNumber(st) });
        continue;
      }
      if (w === 'tag') { st.next(); sel.tags.push(st.next()); continue; }
      if (w === 'keyword') { st.next(); sel.keywords.push(st.next()); continue; }
      throw new Error(`I don't know the word "${w}" here`);
    }
    if (!sel.me && !sel.kinds.length && !sawAny) {
      if (sel.rel === 'enemy' && !sel.kinds.length) sel.kinds.push('card');
      else throw new Error(`expected which cards (like "enemy umas" or "me")${st.peek() ? `, got "${st.peek()}"` : ''}`);
    }
    if (!sel.me && !sel.quant) sel.quant = plural ? 'all' : 'random';
    sel.plural = plural;
    return sel;
  }

  // Where a card goes: base, hand, other lane, random lane, here, race, lane 1/2, deck, trash
  function parseDest(st) {
    st.eat('the'); st.eat('a');
    const w = st.next();
    const pick = {
      base: 'base', hand: 'hand', trash: 'trash', here: 'here', there: 'here', race: 'race',
    }[w];
    if (pick) { st.eat('lane'); return pick; }
    if (w === 'other' || w === 'another') { st.eat('mini'); st.expect('lane'); return 'other lane'; }
    if (w === 'random') { st.eat('mini'); st.expect('lane'); return 'random lane'; }
    if ((w === 'lane' || w === 'mini') && /^[12]$/.test(st.peek() === 'lane' ? st.peek(1) : st.peek())) { st.eat('lane'); return 'mini' + (Number(st.next()) - 1); }
    if (w === 'top' || w === 'bottom') { st.eat('of'); st.eat('my'); st.expect('deck'); return w === 'top' ? 'deck-top' : 'deck-bottom'; }
    if (w === 'my') { const x = st.next(); if (['hand', 'base', 'trash'].includes(x)) return x; if (x === 'deck') return 'deck-top'; }
    throw new Error(`I don't know the place "${w || ''}" (try base, hand, here, other lane, random lane, race, lane 1, lane 2)`);
  }

  // conjure [N] [filters] [to DEST]
  function parseConjure(st) {
    let count = { n: 1 };
    if (isNum(st.peek()) || st.is('count')) count = parseNumber(st);
    const f = { kinds: [], colors: [], tags: [], keywords: [], cmp: [], flags: [], signature: 'no' };
    while (!st.done() && !st.is('to') && !st.is('into')) {
      const w = st.next();
      if (w === 'a' || w === 'an' || w === 'random' || w === 'with' || w === 'that') continue;
      if (COLORS.includes(w)) { f.colors.push(w); continue; }
      if (KINDS[w]) { if (KINDS[w] !== 'card') f.kinds.push(KINDS[w]); continue; }
      if (w === 'champion' || w === 'champions') { f.flags.push('champion'); continue; }
      if (w === 'signature' || w === 'signatures') {
        f.signature = 'any';
        if (st.eat('of', 'my', 'superhorse') || st.eat('mine')) f.signature = 'mine';
        else if (st.eat('of', 'this', 'color')) f.signature = 'color';
        continue;
      }
      if ((w === 'cost' || w === 'power') && (OPS[st.peek()] || (w === 'power' && st.peek() === 'cost'))) {
        if (w === 'power') st.eat('cost');
        f.cmp.push({ field: w === 'power' ? 'power' : 'cost', op: OPS[st.next()], val: parseNumber(st) });
        continue;
      }
      if (w === 'tag') { f.tags.push(st.next()); continue; }
      if (w === 'keyword') { f.keywords.push(st.next()); continue; }
      throw new Error(`I don't know "${w}" in a conjure (try: conjure 2 speed umas cost <= 2 to hand)`);
    }
    let dest = 'hand';
    if (st.eat('to') || st.eat('into')) dest = parseDest(st);
    return { verb: 'conjure', count, filter: f, dest };
  }

  // One action (after any "if ...:").
  function parseAction(st) {
    const w = st.next();
    switch (w) {
      case 'move': { const sel = parseSelector(st, { stop: ['to'] }); st.expect('to', 'after "move …"'); return { verb: 'move', sel, dest: parseDest(st) }; }
      case 'return': { const sel = parseSelector(st, { stop: ['to'] }); st.expect('to'); st.eat('my'); st.eat('its'); st.eat('their'); st.eat('owner\'s'); st.expect('hand'); return { verb: 'move', sel, dest: 'hand' }; }
      case 'conjure': return parseConjure(st);
      case 'create': {
        let count = { n: 1 };
        if (isNum(st.peek()) || st.is('count')) count = parseNumber(st);
        const name = [];
        while (!st.done() && !['to', 'ready', 'into'].includes(st.peek())) name.push(st.next());
        if (!name.length) throw new Error('create what? (e.g. create 2 racer tokens to here)');
        const ready = st.eat('ready');
        let dest = 'base';
        if (st.eat('to') || st.eat('into')) dest = parseDest(st);
        return { verb: 'create', count, token: name.filter(x => !['token', 'tokens', 'a', 'an'].includes(x)).join(' ').replace(/s$/, ''), ready, dest };
      }
      case 'draw': { const n = st.done() ? { n: 1 } : parseNumber(st); st.eat('card'); st.eat('cards'); return { verb: 'draw', count: n }; }
      case 'discard': { const n = st.done() || !(isNum(st.peek()) || st.is('count')) ? { n: 1 } : parseNumber(st); st.eat('random'); st.eat('card'); st.eat('cards'); return { verb: 'discard', count: n }; }
      case 'channel': { const n = st.done() ? { n: 1 } : parseNumber(st); st.eat('star'); st.eat('stars'); return { verb: 'channel', count: n }; }
      case 'gain': case 'lose': { const n = parseNumber(st); st.expect('fans'); return { verb: 'fans', who: 'me', count: n, sign: w === 'gain' ? 1 : -1 }; }
      case 'enemies': case 'each': {
        if (w === 'each') st.expect('enemy');
        const v = st.next();
        if (!['lose', 'loses', 'gain', 'gains'].includes(v)) throw new Error('try "each enemy loses 50 fans"');
        const n = parseNumber(st); st.expect('fans');
        return { verb: 'fans', who: 'enemies', count: n, sign: v.startsWith('gain') ? 1 : -1 };
      }
      case 'give': {
        const sel = parseSelector(st, { stop: [] });
        const sgn = st.next();
        if (!isNum(sgn) || !/^[+-]/.test(sgn)) throw new Error('try "give my umas here +1 might"');
        const temp = st.eat('temp') || st.eat('temporary');
        st.expect('might');
        return { verb: temp ? 'tempMight' : 'might', sel, delta: Number(sgn) };
      }
      case 'deal': { const n = parseNumber(st); st.expect('damage'); st.expect('to'); return { verb: 'damage', sel: parseSelector(st), count: n }; }
      case 'heal': return { verb: 'heal', sel: parseSelector(st) };
      case 'exhaust': return { verb: 'exhaust', sel: parseSelector(st) };
      case 'ready': return { verb: 'ready', sel: parseSelector(st) };
      case 'trash': return { verb: 'trash', sel: parseSelector(st) };
      case 'banish': return { verb: 'banish', sel: parseSelector(st) };
      case 'reveal': st.expect('my'); st.expect('hand'); return { verb: 'revealHand' };
      default: throw new Error(`I don't know the action "${w || ''}" (try move, conjure, create, draw, discard, channel, gain, lose, give, deal, heal, exhaust, ready, return, trash, banish)`);
    }
  }

  // if COND: …   COND: race | ramp | my fans >= N | hand >= N | here is contested | i hold here | count(SEL) >= N | not COND
  function parseCond(st) {
    if (st.eat('not')) return { not: parseCond(st) };
    if (st.eat('race')) return { is: 'race' };
    if (st.eat('ramp')) return { is: 'ramp' };
    if (st.eat('i', 'hold', 'here') || st.eat('i', 'hold', 'this', 'lane')) return { is: 'holdHere' };
    if (st.eat('here', 'is', 'contested') || st.eat('lane', 'is', 'contested') || st.eat('this', 'lane', 'is', 'contested')) return { is: 'contested' };
    let left;
    if (st.eat('my', 'fans') || st.eat('fans')) left = { fans: 'me' };
    else if (st.eat('my', 'hand') || st.eat('hand')) left = { hand: 'me' };
    else if (st.is('count')) left = parseNumber(st);
    else throw new Error(`I don't know the condition "${st.rest()}" (try race, ramp, my fans >= 500, hand >= 4, here is contested, i hold here, count(enemy umas here) >= 2)`);
    const op = OPS[st.next()];
    if (!op) throw new Error('expected a comparison like >= 3');
    return { left, op, right: parseNumber(st) };
  }

  function parseModifier(st) {
    const sel = parseSelector(st);
    let stat;
    if (st.eat('cost') || st.eat('costs') || st.eat('energy', 'cost')) stat = 'cost';
    else if (st.eat('power', 'cost')) stat = 'power';
    else if (st.eat('might')) stat = 'might';
    else if (st.eat('get') || st.eat('gets') || st.eat('have') || st.eat('has')) {
      const d = st.next();
      if (!isNum(d) || !/^[+-]/.test(d)) throw new Error('try "my umas here get +1 might"');
      st.expect('might');
      return { sel, stat: 'might', delta: Number(d) };
    } else throw new Error(`after the cards, expected "cost +N", "power cost +N" or "might +N"${st.peek() ? `, got "${st.peek()}"` : ''}`);
    const d = st.next();
    if (!isNum(d)) throw new Error(`expected a change like +2 or -1 after "${stat === 'power' ? 'power cost' : stat}"`);
    return { sel, stat, delta: Number(d) };
  }

  function parseHead(head, raw = head) {
    const st = new Stream(tokenize(head));
    if (st.eat('always')) { if (!st.done()) throw new Error(`unexpected "${st.rest()}" after "always"`); return { kind: 'always', place: 'board' }; }
    if (st.eat('while')) {
      const rest = st.rest();
      const place = PLACES[rest];
      if (!place) throw new Error(`"while" needs a place: on board, in lane, in hand, on base, in race (got "${rest}")`);
      return { kind: 'while', place };
    }
    if (st.eat('when') || st.eat('whenever') || st.eat('on')) {
      const rest = st.rest().replace(/^this (card )?(is )?/, '').replace(/^it (is )?/, '');
      const t = TRIGGERS.find(x => x[0] === rest);
      if (!t) throw new Error(`I don't know the moment "${rest}" (try: ${TRIGGERS.filter(x => x[2]).map(x => x[0]).join(', ')})`);
      return { kind: 'when', trigger: t[1] };
    }
    if (st.eat('ability')) { return { kind: 'ability', label: st.done() ? null : raw.replace(/^\s*ability\s*/i, '').replace(/^\(|\)$/g, '').trim() }; }
    throw new Error('a rule starts with "while …", "always", "when …" or "ability"');
  }

  // ---------- compile ----------
  function compile(text) {
    const rules = [], errors = [];
    String(text || '').split('\n').forEach((raw, idx) => {
      const line = raw.replace(/#.*$/, '').trim();
      if (!line) return;
      try {
        // The first ":" outside ( ) ends the start of the rule.
        let colon = -1;
        for (let i = 0, depth = 0; i < line.length; i++) {
          if (line[i] === '(') depth++;
          else if (line[i] === ')') depth = Math.max(0, depth - 1);
          else if (line[i] === ':' && !depth) { colon = i; break; }
        }
        if (colon < 0) throw new Error('a rule needs a ":" after its start, e.g. "when played: draw 1"');
        const rule = parseHead(line.slice(0, colon).toLowerCase(), line.slice(0, colon));
        const body = line.slice(colon + 1).toLowerCase().trim();
        if (!body) throw new Error('nothing after the ":"');
        const parts = body.split(';').map(x => x.trim()).filter(Boolean);
        if (rule.kind === 'while' || rule.kind === 'always') {
          rule.mods = parts.map(p => { const st = new Stream(tokenize(p)); const m = parseModifier(st); if (!st.done()) throw new Error(`unexpected "${st.rest()}"`); return m; });
        } else {
          rule.acts = parts.map(p => {
            let cond = null, rest = p;
            const ifm = /^if\s+(.+?):\s*(.+)$/.exec(p);
            if (ifm) { const cs = new Stream(tokenize(ifm[1])); cond = parseCond(cs); if (!cs.done()) throw new Error(`unexpected "${cs.rest()}" in the condition`); rest = ifm[2]; }
            const st = new Stream(tokenize(rest));
            const a = parseAction(st);
            if (!st.done()) throw new Error(`unexpected "${st.rest()}"`);
            if (cond) a.cond = cond;
            return a;
          });
        }
        rule.line = idx + 1;
        rule.src = line;
        rules.push(rule);
      } catch (e) {
        errors.push({ line: idx + 1, message: e.message });
      }
    });
    return { rules, errors };
  }

  // Cached by text, since cards are drawn often.
  const cache = new Map();
  function rulesOf(def) {
    if (!def || !def.code) return [];
    let c = cache.get(def.code);
    if (!c) { c = compile(def.code); cache.set(def.code, c); }
    return c.rules;
  }

  // ---------- plain English ----------
  const KIND_WORD = { uma: ['Uma', 'Umas'], trick: ['Trick', 'Tricks'], trainer: ['Trainer', 'Trainers'], environment: ['Environment', 'Environments'], token: ['token', 'tokens'], card: ['card', 'cards'] };
  const WHERE_WORD = { here: 'in this lane', lane: 'in the lanes', base: 'on base', hand: 'in hand', race: 'in the Race lane', board: 'in play', trash: 'in the trash' };
  const OP_WORD = { le: 'or less', ge: 'or more', lt: 'less than', gt: 'more than', eq: 'exactly', ne: 'not' };
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const one = n => n && n.n === 1;
  const plur = (n, a, b) => (one(n) ? a : b);
  function numText(n) {
    if (n.n != null) return String(n.n);
    if (n.count) return `the number of ${selText(n.count, true).replace(/^all /, '')}`;
    if (n.mul) return `${numText(n.mul[0])} × ${numText(n.mul[1])}`;
    return '?';
  }
  function selText(sel, forcePlural = false) {
    if (sel.me) return 'this card';
    const plural = forcePlural || sel.quant === 'all' || sel.n > 1;
    const kinds = sel.kinds.length ? sel.kinds : ['card'];
    const kw = kinds.map(k => (KIND_WORD[k] || [k, k + 's'])[plural ? 1 : 0]).join(' or ');
    const bits = [];
    if (sel.flags.includes('conjured')) bits.push('conjured');
    for (const f of sel.flags) if (f !== 'conjured') bits.push(f);
    if (sel.colors.length) bits.push(sel.colors.map(cap).join('/'));
    let who = sel.rel === 'my' ? 'your' : sel.rel === 'enemy' ? 'enemy' : '';
    let q = sel.quant === 'all' ? (who ? 'all ' : 'all ') : sel.n > 1 ? `${sel.n} random ` : 'a random ';
    let s = `${q}${who ? who + ' ' : ''}${bits.length ? bits.join(' ') + ' ' : ''}${kw}`;
    if (sel.where) s += ' ' + WHERE_WORD[sel.where];
    for (const c of sel.cmp) s += ` with ${c.field === 'power' ? 'power cost' : c.field} ${c.op === 'eq' ? '' : ''}${numText(c.val)} ${OP_WORD[c.op]}`.replace(' exactly', '');
    if (sel.tags.length) s += ` tagged ${sel.tags.join('/')}`;
    if (sel.keywords.length) s += ` with ${sel.keywords.join('/')}`;
    return s.replace(/\s+/g, ' ').trim();
  }
  const DEST_WORD = { base: 'back to base', hand: 'back to hand', trash: 'to the trash', here: 'into the lane this card was in', race: 'into the Race lane', 'other lane': 'to the other mini lane', 'random lane': 'to a random lane', mini0: 'into Mini lane 1', mini1: 'into Mini lane 2', 'deck-top': 'on top of your deck', 'deck-bottom': 'to the bottom of your deck' };
  function condText(c) {
    if (c.not) return 'not ' + condText(c.not);
    if (c.is === 'race') return 'it\'s the Race';
    if (c.is === 'ramp') return 'it\'s a Ramp';
    if (c.is === 'holdHere') return 'you hold this lane';
    if (c.is === 'contested') return 'this lane is contested';
    const left = c.left.fans ? 'you have' : c.left.hand ? 'your hand has' : numText(c.left);
    const unit = c.left.fans ? ' fans' : c.left.hand ? ' cards' : '';
    return `${left} ${c.left.fans || c.left.hand ? '' : 'is '}${numText(c.right)}${unit} ${OP_WORD[c.op]}`.replace(/\s+/g, ' ');
  }
  function actText(a) {
    let t;
    switch (a.verb) {
      case 'move': t = `move ${selText(a.sel)} ${DEST_WORD[a.dest] || a.dest}`; break;
      case 'conjure': {
        const f = a.filter;
        const kinds = f.kinds.length ? f.kinds.map(k => KIND_WORD[k][one(a.count) ? 0 : 1]).join('/') : plur(a.count, 'card', 'cards');
        const bits = [...f.flags, ...(f.colors.length ? [f.colors.map(cap).join('/')] : []), ...(f.signature !== 'no' ? [`Signature (${f.signature === 'mine' ? 'of your Superhorse' : f.signature === 'color' ? 'of this card\'s color' : 'any'})`] : [])];
        t = `conjure ${one(a.count) ? 'a' : numText(a.count)} random ${bits.join(' ')} ${kinds}`.replace(/\s+/g, ' ');
        for (const c of f.cmp) t += ` with ${c.field === 'power' ? 'power cost' : 'cost'} ${numText(c.val)} ${OP_WORD[c.op]}`;
        t += ` ${DEST_WORD[a.dest] === DEST_WORD.hand ? 'into your hand' : DEST_WORD[a.dest] || a.dest}`;
        break;
      }
      case 'create': t = `create ${one(a.count) ? 'a' : numText(a.count)} ${a.token} ${plur(a.count, 'token', 'tokens')}${a.ready ? ', ready,' : ''} ${DEST_WORD[a.dest] || a.dest}`; break;
      case 'draw': t = one(a.count) ? 'draw a card' : `draw ${numText(a.count)} cards`; break;
      case 'discard': t = `discard ${one(a.count) ? 'a' : numText(a.count)} random ${plur(a.count, 'card', 'cards')} from your hand`; break;
      case 'channel': t = `channel ${numText(a.count)} ${plur(a.count, 'Star', 'Stars')}`; break;
      case 'fans': t = a.who === 'me' ? `${a.sign > 0 ? 'gain' : 'lose'} ${numText(a.count)} fans` : `each enemy ${a.sign > 0 ? 'gains' : 'loses'} ${numText(a.count)} fans`; break;
      case 'might': t = `give ${selText(a.sel)} ${a.delta > 0 ? '+' : ''}${a.delta} might`; break;
      case 'tempMight': t = `give ${selText(a.sel)} ${a.delta > 0 ? '+' : ''}${a.delta} temporary might`; break;
      case 'damage': t = `deal ${numText(a.count)} damage to ${selText(a.sel)}`; break;
      case 'heal': t = `remove all damage from ${selText(a.sel)}`; break;
      case 'revealHand': t = 'reveal your hand'; break;
      default: t = `${a.verb} ${selText(a.sel)}`;
    }
    return a.cond ? `if ${condText(a.cond)}, ${t}` : t;
  }
  function modText(m) {
    const what = m.stat === 'might' ? 'might' : m.stat === 'power' ? 'power cost' : 'energy cost';
    const plural = m.sel.quant === 'all' || m.sel.me ? m.sel.me ? 'has' : 'have' : 'has';
    if (m.stat === 'might') return `${selText(m.sel)} ${plural} ${m.delta > 0 ? '+' : ''}${m.delta} might`;
    return `${selText(m.sel)} cost${m.sel.me || m.sel.quant !== 'all' ? 's' : ''} ${Math.abs(m.delta)} ${m.delta > 0 ? 'more' : 'less'} ${what === 'energy cost' ? 'energy' : 'power'}`;
  }
  const PLACE_WORD = { board: 'on the board', lane: 'in a lane', hand: 'in your hand', base: 'on your base', race: 'in the Race lane' };
  function explain(rule) {
    if (rule.kind === 'while' || rule.kind === 'always') {
      const start = rule.kind === 'always' ? 'While this card is in play' : `While this card is ${PLACE_WORD[rule.place]}`;
      return `${start}, ${rule.mods.map(modText).join('; ')}.`.replace(/all /g, '');
    }
    const acts = rule.acts.map(actText).join(', then ');
    if (rule.kind === 'ability') return `Ability${rule.label ? ` (${rule.label})` : ''}: ${acts}.`;
    return `${cap(TRIGGER_TEXT[rule.trigger] || rule.trigger)}: ${acts}.`;
  }

  // Examples for the card maker's "+ Add rule".
  const TEMPLATES = [
    ['Enemy tricks cost more', 'while on board: enemy tricks cost +2'],
    ['Conjured cards cost less', 'always: cards i conjure cost -1'],
    ['Hold: move and leave an Uma', 'when i hold: move me to random lane; conjure uma to here'],
    ['Played: draw', 'when played: draw 1'],
    ['Lane aura (+might)', 'while in lane: my umas here get +1 might'],
    ['Revealed: exhaust an enemy', 'when revealed: exhaust random enemy uma here'],
    ['Race starts: gain fans', 'when race starts: if count(my umas in race) >= 2: gain 25 fans'],
    ['Units step: ready', 'when my units step: ready me'],
    ['Enters lane: damage', 'when enters lane: deal 1 damage to random enemy uma here'],
    ['Ability: cycle', 'ability: discard 1; draw 1'],
    ['Leaves play: token', 'when leaves play: create 1 racer to base'],
  ];

  const REFERENCE = {
    starts: ['while on board / in lane / in hand / on base / in race:', 'always:', `when ${TRIGGERS.filter(t => t[2]).map(t => t[0]).join(' / ')}:`, 'ability:'],
    cards: ['me', 'my / enemy / any', 'umas, tricks, trainers, environments, tokens, cards', 'speed, stamina, power, guts, wit', 'here, in lanes, on base, in hand, in race, on board', 'random, 2 random, all', 'conjured, champion, signature, exhausted, ready, damaged', 'cost <= 2, might >= 3, tag front-runner, keyword reaction'],
    changes: ['… cost +N / -N', '… power cost +N', '… get +N might'],
    actions: ['move … to base / hand / here / other lane / random lane / race / lane 1 / lane 2', 'return … to hand', 'conjure [N] [filters] [to place]', 'create [N] racer [ready] [to place]', 'draw N · discard N · channel N', 'gain N fans · lose N fans · each enemy loses N fans', 'give … +N might · give … +N temp might', 'deal N damage to … · heal …', 'exhaust … · ready … · trash … · banish …', 'reveal my hand'],
    extras: ['if race: / if ramp: / if my fans >= 500: / if hand >= 4: / if here is contested: / if i hold here: / if count(enemy umas here) >= 2:', 'numbers: 3, count(my umas here), 2 x count(…)', '"here" = the lane this card was in when the rule started', '# starts a comment'],
  };

  return { compile, rulesOf, explain, TEMPLATES, REFERENCE };
})();
