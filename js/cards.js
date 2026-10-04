// Card vocabulary from the rules doc, plus how a card is drawn.
window.Cards = (() => {
  const { h } = U;

  const TYPES = [
    { id: 'speed', label: 'Speed' },
    { id: 'stamina', label: 'Stamina' },
    { id: 'power', label: 'Power' },
    { id: 'guts', label: 'Guts' },
    { id: 'wit', label: 'Wit' },
  ];
  const TYPE_LABEL = Object.fromEntries(TYPES.map(t => [t.id, t.label]));

  const CARD_TYPES = [
    { id: 'uma', label: 'Uma', help: 'A unit. Has might. Normally enters exhausted.' },
    { id: 'trick', label: 'Trick', help: 'A spell. Played, resolved, then trashed.' },
    { id: 'trainer', label: 'Trainer', help: 'Gear. Often attached with Friendship.' },
    { id: 'superhorse', label: 'Superhorse Uma', help: 'Your leader. Exactly two types; your deck may only use those.' },
  ];
  const CARD_TYPE_LABEL = Object.fromEntries(CARD_TYPES.map(t => [t.id, t.label]));

  // Rarity: shown as a gem at the bottom of every card. Higher rarities
  // default to the full-art frame (art fills the whole card).
  const RARITIES = [
    { id: 'common', label: 'Common', gem: '●', fullArt: false },
    { id: 'uncommon', label: 'Uncommon', gem: '◆', fullArt: false },
    { id: 'rare', label: 'Rare', gem: '◆', fullArt: false },
    { id: 'epic', label: 'Epic', gem: '⬢', fullArt: true },
    { id: 'signature', label: 'Signature', gem: '★', fullArt: true },
  ];
  const RARITY = Object.fromEntries(RARITIES.map(r => [r.id, r]));
  // Superhorses always get the full-art frame.
  const isFullArt = def => !!def.full_art || def.card_type === 'superhorse';

  // Running-style tags (shown in the type line; used by Conjure filters).
  // Add more here; the database allows up to 6 tags per card.
  const TAGS = [
    { id: 'front-runner', label: 'Front Runner' },
    { id: 'pace-chaser', label: 'Pace Chaser' },
    { id: 'long-runner', label: 'Long Runner' },
    { id: 'end-closer', label: 'End Closer' },
  ];
  const TAG_LABEL = Object.fromEntries(TAGS.map(t => [t.id, t.label]));
  const isEnvironment = def => (def.keywords || []).includes('environment');
  const isChampion = def => def.card_type === 'uma' && !!def.subtitle;
  const isSignature = def => !!(def && def.signature_of);
  // Tags can be the built-in running styles or any custom word you add.
  const tagLabel = t => TAG_LABEL[t] || t;

  // ---------- Conjure ----------
  // A card's conjure settings describe which pool cards it can create:
  // { count, kind, energyOp, energy, powerOp, power, colors[], champion, tags[], dest }
  const CONJURE_DEFAULT = { count: 1, kind: 'any', energyOp: 'any', energy: 2, powerOp: 'any', power: 1, colors: [], champion: 'any', tags: [], dest: 'hand' };
  const conjureOf = def => (def && def.conjure ? { ...CONJURE_DEFAULT, ...def.conjure } : null);
  const cmp = (op, a, b) => op === 'eq' ? a === b : op === 'le' ? a <= b : op === 'ge' ? a >= b : true;

  function conjureMatches(defs, c) {
    return Object.values(defs).filter(d => d && d.card_type !== 'star' && d.card_type !== 'superhorse' && !d.token &&
      (c.kind === 'any' || d.card_type === c.kind) &&
      cmp(c.energyOp, Number(d.energy || 0), Number(c.energy)) &&
      cmp(c.powerOp, Number(d.power || 0), Number(c.power)) &&
      (!c.colors.length || (d.types || []).some(t => c.colors.includes(t))) &&
      (c.champion === 'any' || (c.champion === 'yes') === isChampion(d)) &&
      (!c.tags.length || (d.tags || []).some(t => c.tags.includes(t))));
  }

  function conjureSummary(c) {
    const op = { eq: '', le: '≤ ', ge: '≥ ' };
    const parts = [];
    if (c.champion === 'yes') parts.push('Champion');
    if (c.colors.length) parts.push(c.colors.map(t => TYPE_LABEL[t]).join('/'));
    if (c.tags.length) parts.push(c.tags.map(tagLabel).join('/'));
    parts.push(c.kind === 'any' ? 'card' : (CARD_TYPE_LABEL[c.kind] || c.kind));
    let s = `${c.count > 1 ? c.count + ' random' : 'a random'} ${parts.join(' ')}${c.count > 1 ? 's' : ''}`;
    const costs = [];
    if (c.energyOp !== 'any') costs.push(`energy ${op[c.energyOp]}${c.energy}`);
    if (c.powerOp !== 'any') costs.push(`power ${op[c.powerOp]}${c.power}`);
    if (c.champion === 'no') costs.push('not a Champion');
    if (costs.length) s += ` (${costs.join(', ')})`;
    return s + ` → ${({ hand: 'hand', base: 'base', 'deck-top': 'top of deck' })[c.dest] || 'hand'}`;
  }

  // Short label shown on small cards so a Trainer (gear) never looks like an Uma.
  const KIND_SHORT = { uma: 'Uma', trick: 'Trick', trainer: 'Trainer', superhorse: 'Superhorse' };

  // group = badge color: timing (teal), placement (pink), effect (lime).
  const KEYWORDS = [
    { id: 'reaction', label: 'Reaction!', group: 'timing', help: 'Play anytime. Can counter tricks and unit abilities.' },
    { id: 'duel', label: 'Duel', group: 'timing', help: 'Strongest in races, but can also be played as a normal trick.' },
    { id: 'uma-roar', label: 'Uma-Roar', group: 'timing', help: 'Do the effect when you draw this card.' },
    { id: 'in-the-shadows', label: 'In the Shadows', group: 'timing', help: 'Played face-down. Reveal at the start of Tricks.' },
    { id: 'friendship', label: 'Friendship', group: 'place', help: 'Attach to a unit, at a cost.' },
    { id: 'interference', label: 'Interference', group: 'place', help: 'Can move from one mini lane to the next.' },
    { id: 'environment', label: 'Environment', group: 'place', help: 'A Trick that stays on a mini lane. One per lane: a new one replaces the old. In the Race, both lanes\' environments apply.' },
    { id: 'conjure', label: 'Conjure', group: 'effect', help: 'Create any card from the named class or group.' },
    { id: 'showboat', label: 'Showboat', group: 'effect', help: 'Do the effect when this enters the Lane.' },
    { id: 'exhaust', label: 'Exhaust', group: 'effect', help: 'Exhaust this card to do its effect.' },
  ];
  const KEYWORD = Object.fromEntries(KEYWORDS.map(k => [k.id, k]));
  const norm = t => String(t).toLowerCase().replace(/[^a-z0-9]/g, '');
  const KEYWORD_BY_NAME = Object.fromEntries(KEYWORDS.flatMap(k => [[norm(k.id), k], [norm(k.label), k]]));

  // ---------- rich card text ----------
  // [Keyword]      → keyword badge        [Keyword>] → badge with an arrow end
  // {E2} {P1}      → energy / power cost  {exhaust} {star} {speed} … {might} {->} {0}-{9}
  // *text*         → italic (reminder text)
  // Any [Word] works: unknown words become grey "custom keyword" badges.
  const SYMBOLS = [
    { token: '{->}', label: 'Arrow' },
    { token: '{exhaust}', label: 'Exhaust symbol' },
    { token: '{E1}', label: 'Energy cost (change the number)' },
    { token: '{P1}', label: 'Power cost (change the number)' },
    { token: '{might}', label: 'Might' },
    { token: '{star}', label: 'Any Star' },
    ...TYPES.map(t => ({ token: `{${t.id}}`, label: `${t.label} Star` })),
    ...Array.from({ length: 10 }, (_, i) => ({ token: `{${i}}`, label: `Number ${i}` })),
  ];

  function symbolNode(code) {
    const c = code.toLowerCase();
    if (c === '->' || c === '>') return h('span', { class: 'sym sym-arrow', title: 'then' }, '➜');
    if (c === 'exhaust') return h('span', { class: 'sym sym-exhaust', title: 'Exhaust this card' }, '⟳');
    if (c === 'might') return h('span', { class: 'sym sym-might', title: 'Might' }, 'M');
    if (c === 'star') return h('span', { class: 'sym sym-star any', title: 'A Star of any type' }, '★');
    if (TYPE_LABEL[c]) return h('span', { class: 'sym sym-star', style: { color: `var(--t-${c})` }, title: `${TYPE_LABEL[c]} Star` }, '★');
    let m = c.match(/^e(\d{0,2})$/);
    if (m) return h('span', { class: 'sym cost-e', title: 'Energy cost' }, m[1] || 'E');
    m = c.match(/^p(\d{0,2})$/);
    if (m) {
      const n = Number(m[1] || 1);
      return h('span', { class: 'sym sym-power', title: `Power cost ${n}: recycle ${n} Star${n === 1 ? '' : 's'}` },
        n <= 4 ? '★'.repeat(n) : `★×${n}`);
    }
    if (/^\d{1,2}$/.test(c)) return h('span', { class: 'sym sym-num' }, c);
    return null;
  }

  function keywordBadge(text, arrow) {
    const kw = KEYWORD_BY_NAME[norm(text)];
    return h('span', {
      class: `kwb kwb-${kw ? kw.group : 'custom'}${arrow ? ' arrow' : ''}`,
      title: kw ? `${kw.label}: ${kw.help}` : 'Custom keyword',
    }, text.trim());
  }

  function richText(text) {
    const out = [];
    const re = /\[([^\]\n]{1,28}?)(>?)\]|\{([a-z0-9>-]{1,8})\}|\*([^*\n]{1,240})\*/gi;
    let last = 0, m;
    while ((m = re.exec(text || ''))) {
      if (m.index > last) out.push(text.slice(last, m.index));
      if (m[1] != null) out.push(keywordBadge(m[1], !!m[2]));
      else if (m[3] != null) out.push(symbolNode(m[3]) || m[0]);
      else out.push(h('em', null, m[4]));
      last = re.lastIndex;
    }
    if (last < (text || '').length) out.push(text.slice(last));
    return out;
  }

  // Keywords already written into the effect text (so we don't show them twice).
  function inlineKeywords(text) {
    const found = new Set();
    for (const m of String(text || '').matchAll(/\[([^\]\n]{1,28}?)>?\]/g)) {
      const kw = KEYWORD_BY_NAME[norm(m[1])];
      if (kw) found.add(kw.id);
    }
    return found;
  }

  const hasMight = def => def.might != null && def.might !== '';

  function monogram(name) {
    const words = (name || '?').trim().split(/\s+/).filter(Boolean);
    return ((words[0] || '?')[0] + (words[1] ? words[1][0] : '')).toUpperCase();
  }

  function typeVars(types) {
    const t = types && types.length ? types : ['speed'];
    return { '--c1': `var(--t-${t[0]})`, '--c2': `var(--t-${t[1] || t[0]})` };
  }

  // size: 's' (table), 'm' (lists), 'l' (hover preview / inspector). Same face, scaled.
  function render(def, opts = {}) {
    if (def.card_type === 'star') return renderStar(def.types[0], opts.size || 'm');
    const el = build(def, opts);
    // Shrink long names / effect text to fit their boxes (same at every size).
    const fit = fitFor(def);
    if (fit.text !== 1) el.querySelector('.card-text').style.fontSize = (TEXT_EM * fit.text).toFixed(3) + 'em';
    if (fit.name !== 1) el.querySelector('.card-name').style.fontSize = (NAME_EM * fit.name).toFixed(3) + 'em';
    if (fit.wrap) el.querySelector('.card-name').classList.add('wrap');
    return el;
  }

  // ---------- auto-fit ----------
  // Cards are sized in em, so a fit measured once (on a hidden card) holds
  // at every size. Results are cached by the card's text.
  const TEXT_EM = 0.68, NAME_EM = 0.95;
  const fitCache = new Map();
  let measureBox = null;
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => fitCache.clear());

  function fitFor(def) {
    const key = [def.name, def.subtitle || '', def.effect, (def.keywords || []).join(','), isFullArt(def) ? 1 : 0, def.card_type].join('\u0001');
    if (fitCache.has(key)) return fitCache.get(key);
    if (!document.body) return { text: 1, name: 1 };
    if (!measureBox) {
      measureBox = document.createElement('div');
      measureBox.setAttribute('aria-hidden', 'true');
      measureBox.style.cssText = 'position:absolute;left:-10000px;top:0;visibility:hidden;pointer-events:none;';
      document.body.append(measureBox);
    }
    const el = build(def, { size: 'm' });
    measureBox.replaceChildren(el);
    const text = el.querySelector('.card-text');
    const name = el.querySelector('.card-name');
    const nm = name.querySelector('.nm');
    // Name first (a very long name may need two lines, which changes the text box).
    let n = 1, wrap = false;
    for (const f of [1, .96, .92, .88, .84, .8, .76, .72, .68, .64, .6, .56]) {
      n = f;
      name.style.fontSize = (NAME_EM * f) + 'em';
      // test 4% larger than we'll use, so rounding at other sizes never clips it
      name.style.fontSize = (NAME_EM * f * 1.04) + 'em';
      const fits = nm.scrollWidth <= nm.clientWidth + 1;
      name.style.fontSize = (NAME_EM * f) + 'em';
      if (fits) break;
    }
    if (nm.scrollWidth > nm.clientWidth + 1) { wrap = true; n = .66; name.style.fontSize = (NAME_EM * n) + 'em'; name.classList.add('wrap'); }
    let t = 1;
    for (const f of [1, .95, .9, .85, .8, .75, .7, .65, .6, .55, .5]) {
      t = f;
      text.style.fontSize = (TEXT_EM * f) + 'em';
      text.style.fontSize = (TEXT_EM * f * 1.03) + 'em';
      const fits = text.scrollHeight <= text.clientHeight + 1;
      text.style.fontSize = (TEXT_EM * f) + 'em';
      if (fits) break;
    }
    measureBox.replaceChildren();
    const out = { text: t, name: n, wrap };
    if (fitCache.size > 2000) fitCache.clear();
    fitCache.set(key, out);
    return out;
  }

  function build(def, { size = 'm' } = {}) {
    const art = h('div', { class: 'card-art' });
    if (def.image_url) art.style.backgroundImage = `url("${def.image_url.startsWith('data:') ? def.image_url : encodeURI(def.image_url)}")`;
    else art.append(h('span', { class: 'art-mono' }, monogram(def.name)));

    // Energy in a circle; Power as a stack of the card's type Stars below it.
    const power = Number(def.power || 0);
    const costs = def.card_type === 'superhorse' && !def.energy && !power ? null : h('div', { class: 'card-costs' },
      h('span', { class: 'cost cost-e', title: `Energy cost ${def.energy || 0}: exhaust ${def.energy || 0} Star${def.energy === 1 ? '' : 's'}` }, def.energy || 0),
      power ? h('span', { class: 'power-stack', title: `Power cost ${power}: recycle ${power} Star${power === 1 ? '' : 's'}` },
        power <= 5
          ? Array.from({ length: power }, () => h('span', { class: 'pw-star' }, '★'))
          : [h('span', { class: 'pw-star' }, '★'), h('span', { class: 'pw-n' }, '×' + power)]) : null);

    // Might: ringed badge in the top-right corner with motion swooshes.
    const might = hasMight(def) ? h('div', { class: 'card-might', title: `Might ${def.might}` }, h('span', { class: 'might-n' }, def.might)) : null;
    const rar = RARITY[def.rarity] || RARITY.common;

    // An Uma with a subtitle is a Champion (like Riftbound's champion units).
    let kindLabel = isToken(def) ? `Token ${CARD_TYPE_LABEL[def.card_type] || ''}`.trim() : isEnvironment(def) ? 'Environment' : isChampion(def) ? 'Champion Uma' : (CARD_TYPE_LABEL[def.card_type] || def.card_type);
    // Signature cards belong to one Superhorse (max 3 per deck).
    if (isSignature(def)) kindLabel = 'Signature ' + kindLabel;
    const tagText = (def.tags || []).map(tagLabel).join(' · ');
    const typeText = (def.types || []).map(t => TYPE_LABEL[t]).join(' / ');
    const typeLine = [kindLabel, typeText, tagText].filter(Boolean).join(' · ');

    const el = h('div', {
      class: `card sz-${size} ct-${def.card_type} r-${rar.id}${isFullArt(def) ? ' full-art' : ''}${isToken(def) ? ' is-token' : ''}${isSignature(def) ? ' is-signature' : ''}`,
      style: typeVars(def.types),
      title: null,
    },
      art,
      costs,
      h('div', { class: 'card-name' },
        h('span', { class: 'nm' }, def.name || 'Untitled'),
        def.subtitle ? h('span', { class: 'sub' }, def.subtitle) : null),
      h('div', { class: 'card-line' }, typeLine),
      textBox(def),
      might,
      isToken(def) ? null : h('span', { class: 'rarity-gem', title: rar.label }, rar.gem),
      size === 's' ? (isToken(def)
        ? h('span', { class: 'card-kind kind-token' }, 'Token')
        : isEnvironment(def)
        ? h('span', { class: 'card-kind kind-environment' }, 'Env')
        : h('span', { class: 'card-kind kind-' + def.card_type }, KIND_SHORT[def.card_type] || def.card_type)) : null,
    );
    return el;
  }

  function textBox(def) {
    const inline = inlineKeywords(def.effect);
    const extra = (def.keywords || []).filter(k => !inline.has(k));
    return h('div', { class: 'card-text' },
      extra.length ? h('div', { class: 'kw-row' }, extra.map(k => keywordBadge(KEYWORD[k] ? KEYWORD[k].label : k, false))) : null,
      def.effect ? h('p', null, richText(def.effect)) : null);
  }

  function renderStar(type, size = 's') {
    return h('div', { class: `star-token sz-${size}`, style: typeVars([type]), title: `${TYPE_LABEL[type]} Star` },
      h('span', { class: 'star-glyph' }, '★'),
      h('span', { class: 'star-label' }, TYPE_LABEL[type]));
  }

  function renderBack(size = 's', label) {
    return h('div', { class: `card card-back sz-${size}` }, h('span', null, label || ''));
  }

  // ---------- Tokens ----------
  // Built-in cards created during play (never in decks). A token that
  // leaves play (to hand, deck or trash) disappears. Add more here.
  const svgArt = svg => 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  // Drawn tall (card-shaped) with the subject in the upper half, above the text.
  const RACER_ART = svgArt(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 140">
    <rect width="100" height="140" fill="#2f6f4f"/>
    <g stroke="#ffffff" stroke-opacity=".16" stroke-width="3">
      <path d="M-5 30 L105 18"/><path d="M-5 52 L105 40"/><path d="M-5 74 L105 62"/><path d="M-5 96 L105 84"/></g>
    <circle cx="50" cy="44" r="30" fill="#ffffff" opacity=".08"/>
    <path d="M50 18 C35 18 28 31 28 44 L28 64 L37 64 L37 45 C37 34 43 28 50 28 C57 28 63 34 63 45 L63 64 L72 64 L72 44 C72 31 65 18 50 18 Z" fill="#f2c14e" stroke="#7a5514" stroke-width="2"/>
    <g fill="#7a5514"><circle cx="32.5" cy="40" r="2"/><circle cx="32" cy="52" r="2"/><circle cx="67.5" cy="40" r="2"/><circle cx="68" cy="52" r="2"/></g></svg>`);
  const CARROT_ART = svgArt(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 140">
    <rect width="100" height="140" fill="#3d5a2a"/>
    <circle cx="50" cy="44" r="32" fill="#f6e7b0" opacity=".14"/>
    <g fill="#5cc96e"><path d="M54 22 C50 10 56 6 60 8 C58 14 58 18 56 23 Z"/><path d="M57 24 C64 13 71 13 72 17 C66 20 62 23 58 26 Z"/><path d="M52 23 C44 14 38 16 38 20 C44 21 48 23 51 26 Z"/></g>
    <path d="M47 24 C56 22 63 28 61 35 L39 70 C37 73 34 72 35 68 L44 31 C45 27 45 25 47 24 Z" fill="#f08a24" stroke="#9a4a0c" stroke-width="1.5"/>
    <g stroke="#9a4a0c" stroke-width="1.5" stroke-linecap="round"><path d="M45 36 L51 37"/><path d="M42 47 L48 48"/><path d="M39 58 L44 59"/></g></svg>`);
  const TOKENS = [
    { id: 'token:racer', name: 'Racer', card_type: 'uma', token: true, types: [], energy: 0, power: 0, might: 1,
      keywords: [], effect: '*A plain racer.*', image_url: RACER_ART, rarity: 'common', full_art: true },
    { id: 'token:carrot', name: 'Carrot', card_type: 'trainer', token: true, types: [], energy: 0, power: 0, might: null,
      keywords: ['exhaust'], effect: '[Exhaust>]: Trash this. Add 1 Energy of any type.', image_url: CARROT_ART, rarity: 'common', full_art: true },
  ];
  const isToken = def => !!(def && def.token);

  // Star "cards" are virtual definitions, one per type.
  function starDef(type) {
    return { id: 'star:' + type, name: TYPE_LABEL[type] + ' Star', card_type: 'star', types: [type], keywords: [], effect: '' };
  }

  // Checks a card before saving (the database repeats these checks).
  function validate(c) {
    const errs = [];
    if (!c.name || !c.name.trim()) errs.push('Give the card a name.');
    if (c.name && c.name.length > 40) errs.push('Names can be at most 40 characters.');
    if (c.subtitle && c.subtitle.length > 40) errs.push('Subtitles can be at most 40 characters.');
    if (!CARD_TYPE_LABEL[c.card_type]) errs.push('Pick a card type.');
    const n = (c.types || []).length;
    if (c.card_type === 'superhorse' && n !== 2) errs.push('A Superhorse Uma needs exactly two types.');
    if (c.card_type !== 'superhorse' && (n < 1 || n > 2)) errs.push('Pick one or two types.');
    for (const k of ['energy', 'power']) {
      const v = Number(c[k] || 0);
      if (!Number.isInteger(v) || v < 0 || v > 15) errs.push(`${k === 'energy' ? 'Energy' : 'Power'} cost must be 0–15.`);
    }
    if (hasMight(c)) {
      const m = Number(c.might);
      if (!Number.isInteger(m) || m < 0 || m > 99) errs.push('Might must be 0–99.');
    }
    if ((c.effect || '').length > 500) errs.push('Effect text can be at most 500 characters.');
    if (c.rarity && !RARITY[c.rarity]) errs.push('Pick a rarity.');
    if ((c.tags || []).length > 6) errs.push('At most 6 tags.');
    if ((c.tags || []).some(t => !String(t).trim() || String(t).length > 24)) errs.push('Tags can be 1–24 characters.');
    if (c.conjure) {
      const n = Number(c.conjure.count);
      if (!Number.isInteger(n) || n < 1 || n > 5) errs.push('Conjure count must be 1–5.');
    }
    for (const k of c.keywords || []) if (!KEYWORD[k]) errs.push(`Unknown keyword "${k}".`);
    return errs;
  }

  return { TOKENS, isToken, TAGS, TAG_LABEL, tagLabel, isSignature, isChampion, isEnvironment, CONJURE_DEFAULT, conjureOf, conjureMatches, conjureSummary, TYPES, TYPE_LABEL, CARD_TYPES, CARD_TYPE_LABEL, RARITIES, RARITY, isFullArt, KEYWORDS, KEYWORD, SYMBOLS, richText, keywordBadge, inlineKeywords, render, renderStar, renderBack, starDef, validate, hasMight, monogram };
})();
