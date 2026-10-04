// Deck list and deck builder.
window.DeckViews = (() => {
  const { h } = U;
  const G = () => window.CONFIG.GAME;

  // Rule checks shown as warnings (not enforced, so friends can test freely).
  function problems(deck, cards) {
    const out = [];
    const leader = cards.find(c => c.id === deck.leader_id);
    if (!leader) out.push('Pick a Superhorse Uma as your leader.');
    const champ = deck.champion_id ? cards.find(c => c.id === deck.champion_id) : null;
    if (deck.champion_id && !champ) out.push('Your Champion was deleted from the pool.');
    if (!deck.champion_id) out.push('Pick a Champion Uma (an Uma with a subtitle) for the Champion slot.');
    if (champ && !Cards.isChampion(champ)) out.push(`${champ.name} isn't a Champion Uma (Champions have a subtitle).`);
    if (champ && leader && !champ.types.every(t => leader.types.includes(t))) out.push(`Your Champion ${champ.name} doesn't match your leader's types.`);
    const total = Object.values(deck.cards || {}).reduce((a, b) => a + b, 0) + (champ ? 1 : 0);
    if (total !== G().DECK_SIZE) out.push(`The deck has ${total} cards${champ ? ' (counting the Champion)' : ''} (should be ${G().DECK_SIZE}).`);
    let sigs = 0;
    for (const [id, n] of Object.entries(deck.cards || {})) {
      const c = cards.find(x => x.id === id);
      if (!c) { out.push('A card in this deck was deleted from the pool.'); continue; }
      const copies = n + (id === deck.champion_id ? 1 : 0);
      if (copies > G().MAX_COPIES) out.push(`${copies} copies of ${c.name}${id === deck.champion_id ? ' (counting the Champion)' : ''} (max ${G().MAX_COPIES}).`);
      if (leader && !c.types.every(t => leader.types.includes(t))) out.push(`${c.name} doesn't match your leader's types.`);
      if (c.signature_of) {
        sigs += n;
        if (c.signature_of !== deck.leader_id) {
          const of = cards.find(x => x.id === c.signature_of);
          out.push(`${c.name} is a Signature card of ${of ? of.name : 'another Superhorse'}.`);
        }
      }
    }
    const maxSig = G().SIGNATURES_PER_DECK ?? 3;
    if (sigs > maxSig) out.push(`${sigs} Signature cards (max ${maxSig}).`);
    const stars = Object.values(deck.stars || {}).reduce((a, b) => a + b, 0);
    if (stars !== G().STAR_DECK_SIZE) out.push(`${stars} Stars (should be ${G().STAR_DECK_SIZE}).`);
    return out;
  }

  async function render(el, openId) {
    const [decks, cards] = await Promise.all([App.backend.listDecks(), App.backend.listCards()]);
    const mine = decks.filter(d => d.owner === App.me.id);
    if (openId) {
      const d = mine.find(x => x.id === openId);
      if (d) return renderBuilder(el, d, cards);
    }
    el.append(h('section', { class: 'page' },
      h('div', { class: 'page-head' },
        h('h1', null, 'Your decks'),
        h('button', { class: 'btn primary', on: { click: () => { el.replaceChildren(); renderBuilder(el, null, cards); } } }, 'New deck')),
      mine.length ? h('div', { class: 'deck-list' }, mine.map(d => {
        const leader = cards.find(c => c.id === d.leader_id);
        const count = Object.values(d.cards || {}).reduce((a, b) => a + b, 0) + (d.champion_id ? 1 : 0);
        const warn = problems(d, cards);
        return h('button', { class: 'deck-tile', on: { click: () => { el.replaceChildren(); renderBuilder(el, d, cards); } } },
          leader ? Cards.render(leader, { size: 's' }) : h('div', { class: 'card card-back sz-s' }),
          h('div', { class: 'deck-tile-body' },
            h('strong', null, d.name),
            h('span', { class: 'muted' }, `${count} cards · ${Object.entries(d.stars || {}).map(([t, n]) => `${n} ${Cards.TYPE_LABEL[t]}`).join(', ') || 'no Stars'}`),
            warn.length ? h('span', { class: 'warn-text' }, `${warn.length} thing${warn.length > 1 ? 's' : ''} to fix`) : h('span', { class: 'ok-text' }, 'Ready to play')));
      })) : h('p', { class: 'muted' }, 'No decks yet. A deck needs a Superhorse Uma leader, so make one in Card maker if the pool has none.')));
  }

  function renderBuilder(el, existing, cards) {
    const deck = existing ? U.clone(existing) : { name: 'New deck', leader_id: null, cards: {}, stars: {} };
    const leaders = cards.filter(c => c.card_type === 'superhorse');
    const leader = () => cards.find(c => c.id === deck.leader_id);
    const champion = () => deck.champion_id ? cards.find(c => c.id === deck.champion_id) : null;
    const fitsLeader = c => { const l = leader(); return !l || c.types.every(t => l.types.includes(t)); };
    const champSel = h('select', { id: 'dk-champ', on: { change: e => { deck.champion_id = e.target.value || null; draw(); } } });
    const champBox = h('div', { class: 'leader-box champ-box' });
    const setChampion = id => { deck.champion_id = id; draw(); };

    const name = h('input', { id: 'dk-name', maxlength: 40, value: deck.name, on: { input: e => (deck.name = e.target.value) } });
    const leaderSel = h('select', { id: 'dk-leader', on: { change: e => {
      deck.leader_id = e.target.value || null;
      const l = leader();
      if (l) {
        const half = Math.floor(G().STAR_DECK_SIZE / 2);
        deck.stars = { [l.types[0]]: G().STAR_DECK_SIZE - half, [l.types[1]]: half };
      }
      draw();
    } } },
      h('option', { value: '' }, 'Choose a leader…'),
      leaders.map(l => h('option', { value: l.id, selected: l.id === deck.leader_id }, `${l.name} (${l.types.map(t => Cards.TYPE_LABEL[t]).join(' / ')})`)));

    const search = h('input', { id: 'dk-search', type: 'search', placeholder: 'Search cards', on: { input: () => drawPool() } });
    const leaderBox = h('div', { class: 'leader-box' });
    const starsBox = h('div', { class: 'stars-box' });
    const poolBox = h('div', { class: 'deck-pool' });
    const listBox = h('div', { class: 'deck-contents' });
    const warnBox = h('ul', { class: 'warn-list' });
    const countEl = h('span', { class: 'deck-count' });

    function setCount(id, n) {
      if (n <= 0) delete deck.cards[id]; else deck.cards[id] = n;
      draw();
    }

    function drawPool() {
      const l = leader();
      const q = search.value.trim().toLowerCase();
      // Signature cards only show for the Superhorse they belong to.
      const fits = cards.filter(c => c.card_type !== 'superhorse' && !Cards.isToken(c) && fitsLeader(c) &&
        (!c.signature_of || (l && c.signature_of === l.id) || deck.cards[c.id]) &&
        (!q || c.name.toLowerCase().includes(q) || (c.effect || '').toLowerCase().includes(q)));
      poolBox.replaceChildren(...(fits.length ? fits.map(c => {
        const n = deck.cards[c.id] || 0;
        const isChamp = deck.champion_id === c.id;
        return h('div', { class: 'pool-item' + (n || isChamp ? ' in' : '') },
          Cards.render(c, { size: 'm' }),
          h('div', { class: 'stepper' },
            h('button', { class: 'icon-btn', 'aria-label': 'Remove one ' + c.name, disabled: !n, on: { click: () => setCount(c.id, n - 1) } }, '−'),
            h('span', { class: 'n' }, n),
            h('button', { class: 'icon-btn', 'aria-label': 'Add one ' + c.name, on: { click: () => setCount(c.id, n + 1) } }, '+')),
          Cards.isChampion(c) ? h('button', { class: 'btn sm' + (isChamp ? ' on' : ' ghost'), 'aria-pressed': String(isChamp),
            on: { click: () => setChampion(isChamp ? null : c.id) } }, isChamp ? '★ Champion' : 'Set as Champion') : null);
      }) : [h('p', { class: 'muted' }, l ? 'No cards in the pool match this leader yet.' : 'Choose a leader to see the cards that fit.')]));
    }

    function draw() {
      const l = leader();
      leaderBox.replaceChildren(l ? Cards.render(l, { size: 'm' }) : h('div', { class: 'card card-back sz-m' }, h('span', null, 'No leader')));
      const champs = cards.filter(c => Cards.isChampion(c) && !Cards.isToken(c) && fitsLeader(c));
      const ch = champion();
      champSel.replaceChildren(h('option', { value: '' }, champs.length ? 'Choose a Champion…' : 'No Champion Umas fit yet'),
        ...champs.map(c => h('option', { value: c.id, selected: c.id === deck.champion_id }, `${c.name}${c.subtitle ? ' — ' + c.subtitle : ''}`)),
        ...(ch && !champs.includes(ch) ? [h('option', { value: ch.id, selected: true }, ch.name + ' (doesn\'t fit)')] : []));
      champBox.replaceChildren(ch ? Cards.render(ch, { size: 'm' }) : h('div', { class: 'card card-back sz-m' }, h('span', null, 'No Champion')));
      // stars split
      if (l) {
        const [a, b] = l.types;
        const total = G().STAR_DECK_SIZE;
        // Pick the split: quick presets (6/6, 7/5…) or step one type up/down.
        const set = v => { v = Math.max(0, Math.min(total, v)); deck.stars = { [a]: v, [b]: total - v }; drawStars(); drawWarn(); };
        const cur = () => deck.stars[a] ?? Math.ceil(total / 2);
        const half = Math.floor(total / 2);
        const presets = [...new Set([half, half + 1, half + 2, half + 3, half - 1, half - 2, half - 3])].filter(v => v >= 0 && v <= total).sort((x, y) => y - x);
        const box = h('div', { class: 'stars-pick' });
        const drawStars = () => {
          const v = cur();
          const side = (t, n, d) => h('div', { class: 'stars-side', style: { '--c1': `var(--t-${t})` } },
            h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': `One less ${Cards.TYPE_LABEL[t]} Star`, disabled: n <= 0, on: { click: () => set(v - d) } }, '−'),
            h('span', { class: 'stars-n' }, h('strong', null, n), ' ', Cards.TYPE_LABEL[t]),
            h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': `One more ${Cards.TYPE_LABEL[t]} Star`, disabled: n >= total, on: { click: () => set(v + d) } }, '+'));
          box.replaceChildren(
            h('div', { class: 'stars-sides' }, side(a, v, 1), h('span', { class: 'muted' }, '/'), side(b, total - v, -1)),
            h('div', { class: 'stars-bar', 'aria-hidden': 'true' },
              h('span', { style: { flex: v, background: `var(--t-${a})` } }), h('span', { style: { flex: total - v, background: `var(--t-${b})` } })),
            h('div', { class: 'stars-presets', role: 'group', 'aria-label': 'Quick splits' }, presets.map(p => h('button', {
              type: 'button', class: 'chip-btn' + (p === v ? ' on' : ''), 'aria-pressed': String(p === v), on: { click: () => set(p) },
            }, `${p}/${total - p}`))));
        };
        drawStars();
        starsBox.replaceChildren(h('span', { class: 'label' }, `Star deck (${total}): ${Cards.TYPE_LABEL[a]} / ${Cards.TYPE_LABEL[b]}`), box);
      } else starsBox.replaceChildren();

      const entries = Object.entries(deck.cards).map(([id, n]) => ({ c: cards.find(x => x.id === id), n })).filter(e => e.c)
        .sort((x, y) => (x.c.energy - y.c.energy) || x.c.name.localeCompare(y.c.name));
      const total = entries.reduce((a, e) => a + e.n, 0) + (champion() ? 1 : 0);
      countEl.textContent = `${total} / ${G().DECK_SIZE}`;
      countEl.className = 'deck-count' + (total === G().DECK_SIZE ? ' ok' : '');
      listBox.replaceChildren(...(entries.length ? entries.map(({ c, n }) => h('div', { class: 'deck-line', style: { '--c1': `var(--t-${c.types[0]})` } },
        h('span', { class: 'deck-line-cost' }, c.energy),
        h('span', { class: 'deck-line-name' }, c.name),
        h('span', { class: 'deck-line-n' }, '×' + n),
        h('button', { class: 'icon-btn sm', 'aria-label': 'Remove one ' + c.name, on: { click: () => setCount(c.id, n - 1) } }, '−'))) : [h('p', { class: 'muted' }, 'Add cards from the left.')]));
      drawPool();
      drawWarn();
    }

    function drawWarn() {
      const w = problems(deck, cards);
      warnBox.replaceChildren(...(w.length ? w.map(x => h('li', null, x)) : [h('li', { class: 'ok-text' }, 'Ready to play.')]));
    }

    // ---- card sleeve: an image + a border, shown on this deck's card backs ----
    let sleeveFile = null;
    let sleevePreview = deck.sleeve && deck.sleeve.image_url || null;
    const sleeveBox = h('div', { class: 'sleeve-box' });
    const sleeveOf = () => ({ image_url: sleevePreview, border: (deck.sleeve && deck.sleeve.border) || 'gold' });
    const setBorder = b => { deck.sleeve = { ...(deck.sleeve || {}), image_url: (deck.sleeve || {}).image_url || null, border: b }; drawSleeve(); };
    const useSleeveImage = async f => {
      if (!f || !/^image\//.test(f.type)) { U.toast("That isn't an image.", 'error'); return; }
      if (f.size > 15 * 1024 * 1024) { U.toast('That image is over 15 MB.', 'error'); return; }
      const r = await Cropper.open(f, { fullArt: true });
      if (!r) return;
      sleeveFile = r.file;
      sleevePreview = r.url;
      deck.sleeve = { ...(deck.sleeve || { border: 'gold' }) };
      drawSleeve();
    };
    const sleeveFileIn = h('input', { type: 'file', id: 'dk-sleeve', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true,
      on: { change: e => { useSleeveImage(e.target.files[0]); e.target.value = ''; } } });
    const colorIn = h('input', { type: 'color', id: 'dk-sleeve-color', 'aria-label': 'Custom border color',
      value: /^#/.test((deck.sleeve || {}).border || '') ? deck.sleeve.border : '#e7b84b', on: { input: e => setBorder(e.target.value) } });
    function drawSleeve() {
      const cur = (deck.sleeve && deck.sleeve.border) || 'gold';
      sleeveBox.replaceChildren(
        h('div', { class: 'sleeve-preview' + (deck.sleeve ? '' : ' default') }, deck.sleeve ? Cards.renderBack('m', '', sleeveOf()) : Cards.renderBack('m', 'Default')),
        h('div', { class: 'stack tight' },
          h('div', { class: 'row wrap' },
            h('button', { type: 'button', class: 'btn sm', on: { click: () => sleeveFileIn.click() } }, sleevePreview ? 'Change image' : 'Choose image'),
            h('button', { type: 'button', class: 'btn sm ghost', on: { click: pasteSleeve } }, 'Paste'),
            deck.sleeve ? h('button', { type: 'button', class: 'btn sm ghost', on: { click: () => { deck.sleeve = null; sleeveFile = null; sleevePreview = null; drawSleeve(); } } }, 'Default sleeve') : null),
          h('span', { class: 'label' }, 'Border'),
          h('div', { class: 'row wrap sleeve-borders' },
            Cards.SLEEVE_BORDERS.map(b => h('button', { type: 'button', class: `chip-btn sb-chip sbc-${b.id}` + (cur === b.id ? ' on' : ''), 'aria-pressed': String(cur === b.id),
              on: { click: () => setBorder(b.id) } }, b.label)),
            h('label', { class: 'chip-btn sb-chip' + (/^#/.test(cur) ? ' on' : ''), for: 'dk-sleeve-color' }, colorIn, 'Custom')),
          h('p', { class: 'hint' }, 'Drop or paste (Ctrl+V) an image here. Your opponent sees this on your deck, your hand and your face-down cards.')),
        sleeveFileIn);
    }
    async function pasteSleeve() {
      try {
        const items = await navigator.clipboard.read();
        for (const it of items) {
          const type = it.types.find(t => t.startsWith('image/'));
          if (type) { await useSleeveImage(new File([await it.getType(type)], 'sleeve.' + type.split('/')[1], { type })); return; }
        }
        U.toast('No image on the clipboard. Right-click an image → Copy image, then try again.', 'error');
      } catch (e) { U.toast('Your browser blocked reading the clipboard. Press Ctrl+V (⌘V on Mac) on this page instead.', 'error'); }
    }
    for (const ev of ['dragenter', 'dragover']) sleeveBox.addEventListener(ev, e => { e.preventDefault(); sleeveBox.classList.add('over'); });
    sleeveBox.addEventListener('dragleave', () => sleeveBox.classList.remove('over'));
    sleeveBox.addEventListener('drop', e => {
      e.preventDefault(); sleeveBox.classList.remove('over');
      const f = [...(e.dataTransfer.files || [])].find(x => /^image\//.test(x.type));
      if (f) useSleeveImage(f); else U.toast('Drop an image file.', 'error');
    });
    const onPaste = e => {
      if (!sleeveBox.isConnected) { document.removeEventListener('paste', onPaste); return; }
      if (document.querySelector('.modal-backdrop')) return;
      const it = [...((e.clipboardData && e.clipboardData.items) || [])].find(x => x.kind === 'file' && /^image\//.test(x.type));
      if (!it) return;
      e.preventDefault();
      useSleeveImage(it.getAsFile());
    };
    document.addEventListener('paste', onPaste);
    drawSleeve();

    const save = h('button', { class: 'btn primary', on: { click: async () => {
      if (!deck.name.trim()) { U.toast('Give the deck a name.', 'error'); return; }
      save.disabled = true;
      try {
        if (sleeveFile) {
          deck.sleeve = { ...(deck.sleeve || { border: 'gold' }), image_url: await App.backend.uploadImage(sleeveFile) };
          sleeveFile = null;
        }
        const saved = await App.backend.saveDeck(deck);
        deck.id = saved.id;
        U.toast('Deck saved.', 'good');
      } catch (e) { U.toast(e.message, 'error'); }
      save.disabled = false;
    } } }, 'Save deck');

    const del = existing ? h('button', { class: 'btn danger ghost', on: { click: async () => {
      if (!(await U.ask(`Delete the deck "${deck.name}"?`, 'Delete', true))) return;
      await App.backend.deleteDeck(deck.id);
      U.toast('Deck deleted.');
      App.go('decks');
    } } }, 'Delete') : null;

    el.append(h('section', { class: 'page' },
      h('div', { class: 'page-head' },
        h('div', { class: 'row' }, h('button', { class: 'btn ghost sm', on: { click: () => App.go('decks') } }, '← Decks'), h('h1', null, 'Deck builder')),
        h('div', { class: 'row' }, del, save)),
      h('div', { class: 'builder' },
        h('div', { class: 'builder-main' },
          h('div', { class: 'filters' }, search),
          poolBox),
        h('aside', { class: 'builder-side' },
          h('div', { class: 'field' }, h('label', { for: 'dk-name' }, 'Deck name'), name),
          h('div', { class: 'field' }, h('label', { for: 'dk-leader' }, 'Superhorse Uma (leader)'), leaderSel),
          leaderBox, starsBox,
          h('div', { class: 'field' }, h('label', { for: 'dk-champ' }, 'Champion slot (counts toward the deck)'), champSel),
          champBox,
          h('div', { class: 'field' }, h('span', { class: 'label' }, 'Card sleeve'), sleeveBox),
          h('div', { class: 'deck-head' }, h('h3', null, 'Main deck'), countEl),
          listBox,
          warnBox))));
    draw();
  }

  return { render, problems };
})();
