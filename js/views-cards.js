// Card pool (everyone's cards) and the card maker.
window.CardViews = (() => {
  const { h } = U;

  // ---------- pool ----------
  async function renderPool(el) {
    const [cards, profiles] = await Promise.all([App.backend.listCards(), App.backend.listProfiles()]);
    const by = id => (profiles.find(p => p.id === id) || {}).display_name || 'someone';
    const search = h('input', { id: 'pool-search', type: 'search', placeholder: 'Search names and text' });
    const typeSel = h('select', { id: 'pool-type', 'aria-label': 'Type' },
      h('option', { value: '' }, 'All types'), Cards.TYPES.map(t => h('option', { value: t.id }, t.label)));
    const rarSel = h('select', { id: 'pool-rarity', 'aria-label': 'Rarity' },
      h('option', { value: '' }, 'All rarities'), Cards.RARITIES.map(r => h('option', { value: r.id }, r.label)));
    const kindSel = h('select', { id: 'pool-kind', 'aria-label': 'Card type' },
      h('option', { value: '' }, 'All card types'), Cards.CARD_TYPES.map(t => h('option', { value: t.id }, t.label)));
    const mineOnly = h('input', { id: 'pool-mine', type: 'checkbox' });
    const grid = h('div', { class: 'card-grid' });
    const count = h('span', { class: 'muted' });

    function draw() {
      const q = search.value.trim().toLowerCase();
      const list = cards.filter(c =>
        (!q || c.name.toLowerCase().includes(q) || (c.subtitle || '').toLowerCase().includes(q) || (c.effect || '').toLowerCase().includes(q)) &&
        (!typeSel.value || c.types.includes(typeSel.value)) &&
        (!kindSel.value || c.card_type === kindSel.value) &&
        (!rarSel.value || (c.rarity || 'common') === rarSel.value) &&
        (!mineOnly.checked || c.owner === App.me.id));
      count.textContent = `${list.length} of ${cards.length} cards`;
      grid.replaceChildren(...list.map(c => h('button', { class: 'grid-card', on: { click: () => showCard(c, by(c.owner)) } },
        Cards.render(c, { size: 'm' }),
        h('span', { class: 'by' }, 'by ' + by(c.owner)))));
      if (!list.length) grid.append(h('p', { class: 'muted' }, cards.length ? 'No cards match those filters.' : 'No cards yet. Make the first one in Card maker.'));
    }
    [search, typeSel, kindSel, rarSel, mineOnly].forEach(x => x.addEventListener('input', draw));

    el.append(h('section', { class: 'page' },
      h('div', { class: 'page-head' },
        h('div', null, h('h1', null, 'Card pool'), count),
        h('div', { class: 'row wrap' },
          App.me.admin && App.backend.mode !== 'demo' && App.backend.importSamples ? h('button', { class: 'btn', on: { click: async e => {
            if (!(await U.ask('Add the 30 sample cards and 2 sample decks to the card pool? Cards with a name already in the pool are skipped. You can edit or delete them afterwards.', 'Import'))) return;
            const btn = e.target.closest('button');
            btn.disabled = true;
            try {
              const r = await App.backend.importSamples();
              U.toast(`Imported ${r.cards} card${r.cards === 1 ? '' : 's'}${r.skipped ? ` (${r.skipped} already there)` : ''} and ${r.decks} deck${r.decks === 1 ? '' : 's'}.`, 'good');
              App.go('cards');
            } catch (err) { U.toast(err.message, 'error'); btn.disabled = false; }
          } } }, 'Import sample cards') : null,
          h('button', { class: 'btn primary', on: { click: () => App.go('maker') } }, 'New card'))),
      h('div', { class: 'filters' }, search, typeSel, kindSel, rarSel,
        h('label', { class: 'check', for: 'pool-mine' }, mineOnly, 'Only mine')),
      grid));
    draw();
  }

  function showCard(c, author) {
    const mine = c.owner === App.me.id || !!App.me.admin;
    const m = U.modal(c.name, h('div', { class: 'card-detail' },
      Cards.render(c, { size: 'l' }),
      h('div', { class: 'stack' },
        h('p', { class: 'muted' }, 'Made by ' + author),
        (c.keywords || []).length ? h('dl', { class: 'kw-help' }, c.keywords.map(k => Cards.KEYWORD[k] ? [h('dt', null, Cards.KEYWORD[k].label), h('dd', null, Cards.KEYWORD[k].help)] : null)) : null,
        mine ? h('div', { class: 'row' },
          h('button', { class: 'btn', on: { click: () => { m.close(); App.go('maker', c); } } }, 'Edit'),
          h('button', { class: 'btn danger', on: { click: async () => {
            if (!(await U.ask(`Delete "${c.name}" for everyone? Decks using it will lose it.`, 'Delete', true))) return;
            try { await App.backend.deleteCard(c.id); m.close(); U.toast('Card deleted.'); App.go('cards'); } catch (e) { U.toast(e.message, 'error'); }
          } } }, 'Delete')) : null)));
  }

  // ---------- maker ----------
  function renderMaker(el, editing) {
    const card = editing ? U.clone(editing) : {
      name: '', card_type: 'uma', types: ['speed'], energy: 1, power: 0, might: 2, keywords: [], effect: '', image_url: null,
      rarity: 'common', full_art: false, subtitle: '', tags: [], conjure: null,
    };
    card.tags = card.tags || [];
    card.conjure = Cards.conjureOf(card) || { ...Cards.CONJURE_DEFAULT };
    let pool = [];
    App.backend.listCards().then(list => { pool = list; drawPreview(); }).catch(() => {});
    let imageFile = null;
    let previewUrl = card.image_url;
    const preview = h('div', { class: 'maker-preview' });
    const errors = h('ul', { class: 'form-error' });

    const drawPreview = () => {
      preview.replaceChildren(Cards.render({ ...card, image_url: previewUrl }, { size: 'l' }));
      if (typeof drawConjure === 'function') drawConjure();
    };

    // name
    const name = h('input', { id: 'mk-name', maxlength: 40, value: card.name, placeholder: 'e.g. Morning Gallop', on: { input: e => { card.name = e.target.value; drawPreview(); } } });
    const subtitle = h('input', { id: 'mk-sub', maxlength: 40, value: card.subtitle || '', placeholder: 'e.g. Queen of the Final Turn',
      on: { input: e => { card.subtitle = e.target.value; drawPreview(); } } });

    // card type
    const kindRow = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Card type' });
    const kindHelp = h('p', { class: 'hint' });
    const drawKinds = () => {
      kindRow.replaceChildren(...Cards.CARD_TYPES.map(t => h('button', {
        type: 'button', role: 'radio', 'aria-checked': String(card.card_type === t.id),
        class: 'seg-btn' + (card.card_type === t.id ? ' on' : ''),
        on: { click: () => {
          card.card_type = t.id;
          if (t.id === 'superhorse') { card.energy = 0; card.power = 0; if (card.might == null || card.might === '') card.might = 4; }
          if (t.id === 'trick') card.might = null;
          if (t.id === 'superhorse') { card.full_art = true; if (fullArtCb) fullArtCb.checked = true; }
          syncFields(); drawKinds(); drawTypes(); drawPreview();
        } },
      }, t.label)));
      kindHelp.textContent = Cards.CARD_TYPES.find(t => t.id === card.card_type).help;
    };

    // types
    const typeRow = h('div', { class: 'type-chips' });
    const typeHelp = h('p', { class: 'hint' });
    const drawTypes = () => {
      const max = 2;
      typeRow.replaceChildren(...Cards.TYPES.map(t => {
        const on = card.types.includes(t.id);
        return h('button', {
          type: 'button', class: 'type-chip' + (on ? ' on' : ''), 'aria-pressed': String(on),
          style: { '--c1': `var(--t-${t.id})` },
          on: { click: () => {
            if (on) card.types = card.types.filter(x => x !== t.id);
            else card.types = [...card.types, t.id].slice(-max);
            drawTypes(); drawPreview();
          } },
        }, t.label);
      }));
      typeHelp.textContent = card.card_type === 'superhorse'
        ? 'Pick exactly two. Decks using this leader can only use cards of these types.'
        : 'Pick one, or two for a dual-type card (only fits decks whose leader has both).';
    };

    // rarity
    if (!card.rarity) card.rarity = 'common';
    const fullArtCb = h('input', { id: 'mk-fullart', type: 'checkbox', checked: Cards.isFullArt(card),
      on: { change: e => { card.full_art = e.target.checked; drawPreview(); } } });
    const rarityRow = h('div', { class: 'seg rarity-seg', role: 'radiogroup', 'aria-label': 'Rarity' });
    const drawRarity = () => rarityRow.replaceChildren(...Cards.RARITIES.map(r => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(card.rarity === r.id),
      class: `seg-btn r-${r.id}` + (card.rarity === r.id ? ' on' : ''),
      on: { click: () => {
        const was = Cards.RARITY[card.rarity];
        card.rarity = r.id;
        // follow the rarity's default unless the user has set it differently
        if (card.card_type !== 'superhorse' && (!was || card.full_art === was.fullArt)) { card.full_art = r.fullArt; fullArtCb.checked = r.fullArt; }
        drawRarity(); drawPreview();
      } },
    }, h('span', { class: 'rar-gem' }, r.gem), r.label)));
    drawRarity();

    // tags
    const tagRow = h('div', { class: 'type-chips' });
    const drawTags = () => tagRow.replaceChildren(...Cards.TAGS.map(t => {
      const on = card.tags.includes(t.id);
      return h('button', { type: 'button', class: 'type-chip tag-chip' + (on ? ' on' : ''), 'aria-pressed': String(on),
        on: { click: () => { card.tags = on ? card.tags.filter(x => x !== t.id) : [...card.tags, t.id]; drawTags(); drawPreview(); } } }, t.label);
    }));
    drawTags();

    // conjure settings (shown when the card has the Conjure keyword)
    const cj = card.conjure;
    const sel = (id, value, options, onChange) => {
      const el2 = h('select', { id, on: { change: e => { onChange(e.target.value); drawPreview(); } } },
        options.map(([v, label]) => h('option', { value: v, selected: String(v) === String(value) }, label)));
      return el2;
    };
    const numIn = (id, value, min, max, onChange) => h('input', { id, type: 'number', min, max, step: 1, value,
      on: { input: e => { onChange(Math.max(min, Math.min(max, Number(e.target.value) || 0))); drawPreview(); } } });
    const OPS = [['any', 'Any'], ['eq', 'Exactly'], ['le', 'Or less'], ['ge', 'Or more']];
    // "Any" switches the number off; the other choices compare against it.
    const costField = (id, label, opKey, valKey) => {
      const input = numIn(id, cj[valKey], 0, 15, v => (cj[valKey] = v));
      input.disabled = cj[opKey] === 'any';
      input.setAttribute('aria-label', label + ' value');
      const op = sel(id + 'op', cj[opKey], OPS, v => { cj[opKey] = v; input.disabled = v === 'any'; });
      return h('div', { class: 'field' }, h('label', { for: id + 'op' }, label), h('div', { class: 'row' }, op, input));
    };
    const chipSet = (items, key) => {
      const row = h('div', { class: 'type-chips' });
      const draw = () => row.replaceChildren(...items.map(([id, label, color]) => {
        const on = cj[key].includes(id);
        return h('button', { type: 'button', class: 'type-chip' + (color ? '' : ' tag-chip') + (on ? ' on' : ''), 'aria-pressed': String(on),
          style: color ? { '--c1': `var(--t-${id})` } : null,
          on: { click: () => { cj[key] = on ? cj[key].filter(x => x !== id) : [...cj[key], id]; draw(); drawPreview(); } } }, label);
      }));
      draw();
      return row;
    };
    const cjSummary = h('p', { class: 'conjure-summary' });
    const conjureBox = h('fieldset', { class: 'conjure-box' },
      h('legend', null, 'Conjure settings'),
      h('p', { class: 'hint' }, 'In a match, right-click this card → Conjure to create random cards from the pool that match these filters. Leave a filter on Any to skip it.'),
      h('div', { class: 'cj-grid' },
        h('div', { class: 'field' }, h('label', { for: 'cj-kind' }, 'Card type'),
          sel('cj-kind', cj.kind, [['any', 'Any'], ['uma', 'Uma'], ['trick', 'Trick'], ['trainer', 'Trainer']], v => (cj.kind = v))),
        h('div', { class: 'field' }, h('label', { for: 'cj-champ' }, 'Champion'),
          sel('cj-champ', cj.champion, [['any', 'Any'], ['yes', 'Champions only'], ['no', 'No Champions']], v => (cj.champion = v))),
        costField('cj-e', 'Energy cost', 'energyOp', 'energy'),
        costField('cj-p', 'Power cost', 'powerOp', 'power'),
        h('div', { class: 'field' }, h('label', { for: 'cj-count' }, 'How many'), numIn('cj-count', cj.count, 1, 5, v => (cj.count = v))),
        h('div', { class: 'field' }, h('label', { for: 'cj-dest' }, 'Goes to'),
          sel('cj-dest', cj.dest, [['hand', 'Hand'], ['base', 'Base'], ['deck-top', 'Top of deck']], v => (cj.dest = v)))),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Color (any of)'), chipSet(Cards.TYPES.map(t => [t.id, t.label, true]), 'colors')),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Tags (any of)'), chipSet(Cards.TAGS.map(t => [t.id, t.label]), 'tags')),
      cjSummary);
    function drawConjure() {
      conjureBox.hidden = !card.keywords.includes('conjure');
      if (conjureBox.hidden) return;
      const defs = Object.fromEntries(pool.map(c => [c.id, c]));
      const n = Cards.conjureMatches(defs, cj).length;
      cjSummary.replaceChildren(h('strong', null, 'Conjures ' + Cards.conjureSummary(cj) + '. '),
        h('span', { class: n ? 'ok-text' : 'warn-text' }, n ? `${n} card${n === 1 ? '' : 's'} in the pool match right now.` : 'No cards in the pool match yet.'));
    }

    const num = (id, key, label, help) => {
      const input = h('input', { id, type: 'number', min: 0, max: key === 'might' ? 99 : 15, step: 1, value: card[key] ?? '',
        on: { input: e => { card[key] = e.target.value === '' ? null : Number(e.target.value); drawPreview(); } } });
      return { input, field: h('div', { class: 'field' }, h('label', { for: id }, label), input, help ? h('p', { class: 'hint' }, help) : null) };
    };
    const energy = num('mk-energy', 'energy', 'Energy cost', 'Paid by exhausting Stars.');
    const power = num('mk-power', 'power', 'Power cost', 'Paid by recycling Stars.');
    const might = num('mk-might', 'might', 'Might', 'Leave empty for no might (most tricks).');
    function syncFields() {
      energy.input.value = card.energy ?? 0;
      power.input.value = card.power ?? 0;
      might.input.value = card.might ?? '';
    }

    // keywords
    const kwBox = h('div', { class: 'kw-pick' }, Cards.KEYWORDS.map(k => {
      const cb = h('input', { type: 'checkbox', id: 'kw-' + k.id, checked: card.keywords.includes(k.id),
        on: { change: e => {
          autoKw.delete(k.id);
          card.keywords = e.target.checked ? [...card.keywords, k.id] : card.keywords.filter(x => x !== k.id);
          drawPreview();
        } } });
      return h('label', { class: 'kw-option', for: 'kw-' + k.id }, cb, h('span', null, h('strong', null, k.label), h('small', null, k.help)));
    }));

    // effect
    const counter = h('span', { class: 'hint' });
    const effect = h('textarea', { id: 'mk-effect', rows: 5, maxlength: 500, placeholder: '[Uma-Roar>]: Channel 1 {star}, exhausted.',
      on: { input: e => onEffect(e.target.value) } });
    effect.value = card.effect;
    counter.textContent = `${card.effect.length}/500`;

    // Keywords written into the text are tagged on the card automatically.
    // Keywords added this way are removed again if you delete them from the text.
    const autoKw = new Set();
    function onEffect(v) {
      card.effect = v;
      counter.textContent = `${v.length}/500`;
      const inline = Cards.inlineKeywords(v);
      for (const id of inline) {
        if (!card.keywords.includes(id)) {
          card.keywords = [...card.keywords, id];
          autoKw.add(id);
          const cb = document.getElementById('kw-' + id);
          if (cb) cb.checked = true;
        }
      }
      for (const id of [...autoKw]) {
        if (!inline.has(id)) {
          autoKw.delete(id);
          card.keywords = card.keywords.filter(k => k !== id);
          const cb = document.getElementById('kw-' + id);
          if (cb) cb.checked = false;
        }
      }
      drawPreview();
    }

    function insert(text) {
      const start = effect.selectionStart ?? effect.value.length;
      const end = effect.selectionEnd ?? effect.value.length;
      effect.focus();
      effect.setRangeText(text, start, end, 'end');
      onEffect(effect.value);
    }

    // "Text modifiers" toolbar, like a Riftbound card maker.
    const arrowCb = h('input', { type: 'checkbox', id: 'tt-arrow', checked: true });
    const helpCb = h('input', { type: 'checkbox', id: 'tt-help' });
    const tools = h('div', { class: 'text-tools' },
      h('span', { class: 'hint' }, 'Text modifiers: click to insert at the cursor'),
      h('div', { class: 'tool-row' }, Cards.SYMBOLS.map(sy => h('button', {
        type: 'button', class: 'tool-btn', title: `${sy.label}  ${sy.token}`, 'aria-label': sy.label,
        on: { click: () => insert(sy.token) },
      }, Cards.richText(sy.token)))),
      h('div', { class: 'tool-checks' },
        h('label', { for: 'tt-help' }, helpCb, 'Add keyword helper text'),
        h('label', { for: 'tt-arrow' }, arrowCb, 'Add keyword arrow')),
      h('div', { class: 'tool-row' }, Cards.KEYWORDS.map(k => h('button', {
        type: 'button', class: 'tool-kw', title: k.help,
        on: { click: () => {
          const label = k.label.replace(/!$/, '');
          let t = `[${label}${arrowCb.checked ? '>' : ''}]`;
          if (helpCb.checked) t += ` *(${k.help})*`;
          t += arrowCb.checked ? ': ' : ' ';
          insert(t);
        } },
      }, Cards.keywordBadge(k.label.replace(/!$/, ''), arrowCb.checked)))),
      h('p', { class: 'hint' }, 'Write ', h('code', null, '[Any Word]'), ' for your own keyword, ', h('code', null, '[Word>]'),
        ' for the arrow shape, ', h('code', null, '*text*'), ' for italics, ', h('code', null, '{E2}'), ' / ', h('code', null, '{P1}'), ' for costs.'));
    // Keep the keyword buttons' shape in step with the arrow checkbox.
    arrowCb.addEventListener('change', () => tools.querySelectorAll('.tool-kw .kwb').forEach(b => b.classList.toggle('arrow', arrowCb.checked)));

    // art
    const file = h('input', { id: 'mk-art', type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif',
      on: { change: e => {
        const f = e.target.files[0];
        if (!f) return;
        if (f.size > 2 * 1024 * 1024) { U.toast('Images can be at most 2 MB.', 'error'); e.target.value = ''; return; }
        imageFile = f;
        previewUrl = URL.createObjectURL(f);
        drawPreview();
      } } });
    const clearArt = h('button', { type: 'button', class: 'btn ghost sm', on: { click: () => { imageFile = null; previewUrl = null; card.image_url = null; file.value = ''; drawPreview(); } } }, 'Remove art');

    const save = h('button', { class: 'btn primary', type: 'submit' }, editing ? 'Save changes' : 'Add to card pool');
    const form = h('form', { class: 'maker-form', on: { submit: async e => {
      e.preventDefault();
      if (!card.keywords.includes('conjure')) card.conjure = null;
      else card.conjure = cj;
      const errs = Cards.validate(card);
      errors.replaceChildren(...errs.map(x => h('li', null, x)));
      if (errs.length) return;
      save.disabled = true;
      try {
        const saved = await App.backend.saveCard(card, imageFile);
        U.toast(`"${saved.name}" ${editing ? 'saved' : 'added to the pool'}.`, 'good');
        App.go('cards');
      } catch (e2) {
        errors.replaceChildren(h('li', null, e2.message));
      }
      save.disabled = false;
    } } },
      h('div', { class: 'field' }, h('label', { for: 'mk-name' }, 'Name'), name),
      h('div', { class: 'field' }, h('label', { for: 'mk-sub' }, 'Subtitle (optional)'), subtitle,
        h('p', { class: 'hint' }, 'Shown under the name. An Uma with a subtitle becomes a Champion Uma.')),
      h('fieldset', null, h('legend', null, 'Card type'), kindRow, kindHelp),
      h('fieldset', null, h('legend', null, 'Types'), typeRow, typeHelp),
      h('fieldset', null, h('legend', null, 'Rarity'), rarityRow,
        h('label', { class: 'check', for: 'mk-fullart' }, fullArtCb, 'Full-art frame (the art fills the whole card)'),
        h('p', { class: 'hint' }, 'Epic and Signature cards use full art by default. Leaders always do.')),
      h('div', { class: 'num-row' }, energy.field, power.field, might.field),
      h('fieldset', null, h('legend', null, 'Tags'), tagRow,
        h('p', { class: 'hint' }, 'Running style. Shown in the type line, and Conjure effects can filter by it.')),
      h('fieldset', null, h('legend', null, 'Keywords'), kwBox),
      conjureBox,
      h('div', { class: 'field' }, h('label', { for: 'mk-effect' }, 'Effect text'), effect, counter, tools),
      h('div', { class: 'field' }, h('label', { for: 'mk-art' }, 'Card art'), h('div', { class: 'row' }, file, clearArt),
        h('p', { class: 'hint' }, 'PNG, JPG, WebP or GIF, up to 2 MB. Use art you made or have permission to use. Without art, the card shows its initials.')),
      errors,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn ghost', on: { click: () => App.go('cards') } }, 'Cancel'),
        save));

    el.append(h('section', { class: 'page' },
      h('div', { class: 'page-head' }, h('h1', null, editing ? 'Edit card' : 'Card maker')),
      h('div', { class: 'maker' }, form, h('div', { class: 'maker-side' }, h('p', { class: 'eyebrow' }, 'Preview'), preview))));
    drawKinds(); drawTypes(); drawPreview();
  }

  return { renderPool, renderMaker };
})();
