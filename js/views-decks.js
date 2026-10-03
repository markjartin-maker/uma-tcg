// Deck list and deck builder.
window.DeckViews = (() => {
  const { h } = U;
  const G = () => window.CONFIG.GAME;

  // Rule checks shown as warnings (not enforced, so friends can test freely).
  function problems(deck, cards) {
    const out = [];
    const leader = cards.find(c => c.id === deck.leader_id);
    if (!leader) out.push('Pick a Superhorse Uma as your leader.');
    const total = Object.values(deck.cards || {}).reduce((a, b) => a + b, 0);
    if (total !== G().DECK_SIZE) out.push(`The deck has ${total} cards (should be ${G().DECK_SIZE}).`);
    for (const [id, n] of Object.entries(deck.cards || {})) {
      const c = cards.find(x => x.id === id);
      if (!c) { out.push('A card in this deck was deleted from the pool.'); continue; }
      if (n > G().MAX_COPIES) out.push(`${n} copies of ${c.name} (max ${G().MAX_COPIES}).`);
      if (leader && !c.types.every(t => leader.types.includes(t))) out.push(`${c.name} doesn't match your leader's types.`);
    }
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
        const count = Object.values(d.cards || {}).reduce((a, b) => a + b, 0);
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
      const fits = cards.filter(c => c.card_type !== 'superhorse' && (!l || c.types.every(t => l.types.includes(t))) &&
        (!q || c.name.toLowerCase().includes(q) || (c.effect || '').toLowerCase().includes(q)));
      poolBox.replaceChildren(...(fits.length ? fits.map(c => {
        const n = deck.cards[c.id] || 0;
        return h('div', { class: 'pool-item' + (n ? ' in' : '') },
          Cards.render(c, { size: 'm' }),
          h('div', { class: 'stepper' },
            h('button', { class: 'icon-btn', 'aria-label': 'Remove one ' + c.name, disabled: !n, on: { click: () => setCount(c.id, n - 1) } }, '−'),
            h('span', { class: 'n' }, n),
            h('button', { class: 'icon-btn', 'aria-label': 'Add one ' + c.name, on: { click: () => setCount(c.id, n + 1) } }, '+')));
      }) : [h('p', { class: 'muted' }, l ? 'No cards in the pool match this leader yet.' : 'Choose a leader to see the cards that fit.')]));
    }

    function draw() {
      const l = leader();
      leaderBox.replaceChildren(l ? Cards.render(l, { size: 'm' }) : h('div', { class: 'card card-back sz-m' }, h('span', null, 'No leader')));
      // stars split
      if (l) {
        const [a, b] = l.types;
        const total = G().STAR_DECK_SIZE;
        const range = h('input', { id: 'dk-stars', type: 'range', min: 0, max: total, step: 1, value: deck.stars[a] ?? Math.ceil(total / 2),
          'aria-label': `${Cards.TYPE_LABEL[a]} Stars`,
          on: { input: e => { const v = Number(e.target.value); deck.stars = { [a]: v, [b]: total - v }; drawStarsLabel(); drawWarn(); } } });
        const label = h('div', { class: 'stars-label' });
        const drawStarsLabel = () => label.replaceChildren(
          h('span', { style: { color: `var(--t-${a})` } }, `${deck.stars[a] || 0} ${Cards.TYPE_LABEL[a]}`),
          h('span', { style: { color: `var(--t-${b})` } }, `${deck.stars[b] || 0} ${Cards.TYPE_LABEL[b]}`));
        drawStarsLabel();
        starsBox.replaceChildren(h('label', { for: 'dk-stars' }, `Star deck (${total})`), range, label);
      } else starsBox.replaceChildren();

      const entries = Object.entries(deck.cards).map(([id, n]) => ({ c: cards.find(x => x.id === id), n })).filter(e => e.c)
        .sort((x, y) => (x.c.energy - y.c.energy) || x.c.name.localeCompare(y.c.name));
      const total = entries.reduce((a, e) => a + e.n, 0);
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

    const save = h('button', { class: 'btn primary', on: { click: async () => {
      if (!deck.name.trim()) { U.toast('Give the deck a name.', 'error'); return; }
      save.disabled = true;
      try {
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
          h('div', { class: 'deck-head' }, h('h3', null, 'Main deck'), countEl),
          listBox,
          warnBox))));
    draw();
  }

  return { render, problems };
})();
