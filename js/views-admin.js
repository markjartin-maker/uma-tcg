// Admin panel: the card back everyone sees, and the game's sounds.
// Only admins see the page (the database also only lets admins save).
window.AdminViews = (() => {
  const h = U.h;
  const SOUND_TYPES = 'audio/mpeg,audio/mp3,audio/ogg,audio/wav,audio/x-wav,audio/wave,audio/webm,audio/mp4,audio/aac,audio/x-m4a,.mp3,.ogg,.wav,.m4a,.webm,.aac';
  const SOUND_MAX = 5 * 1024 * 1024;

  // A sound picker: Upload / ▶ / Remove + volume. value: { url, name, volume } | null
  function soundPicker(value, onChange, { id } = {}) {
    let cur = value ? { volume: 1, ...value } : null;
    const box = h('div', { class: 'snd-pick' });
    const file = h('input', { type: 'file', accept: SOUND_TYPES, hidden: true, id: id || null, on: { change: async e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      if (!/^audio\//.test(f.type) && !/\.(mp3|ogg|wav|m4a|webm|aac)$/i.test(f.name)) { U.toast("That isn't a sound file. Use MP3, OGG, WAV, M4A or WebM.", 'error'); return; }
      if (f.size > SOUND_MAX) { U.toast('That sound is over 5 MB.', 'error'); return; }
      status.textContent = 'Uploading…';
      try {
        const url = await App.backend.uploadSound(f);
        cur = { url, name: f.name.slice(0, 60), volume: cur ? cur.volume : 1 };
        await onChange(cur);
        draw();
        Sound.playUrl(cur.url, cur.volume, 'preview');
      } catch (err) { status.textContent = ''; U.toast(err.message, 'error'); }
    } } });
    const status = h('span', { class: 'snd-name' });
    function draw() {
      status.textContent = cur ? cur.name || 'Sound' : 'No sound';
      status.classList.toggle('muted', !cur);
      const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: cur ? cur.volume : 1, disabled: !cur, 'aria-label': 'Volume',
        on: { change: async e => { cur = { ...cur, volume: Number(e.target.value) }; await onChange(cur); } } });
      box.replaceChildren(file, h('span', { class: 'snd-icon', 'aria-hidden': 'true' }, cur ? '♪' : '–'), status,
        h('div', { class: 'row tight' },
          h('button', { type: 'button', class: 'btn sm', on: { click: () => file.click() } }, cur ? 'Replace' : 'Upload'),
          h('button', { type: 'button', class: 'btn sm ghost', disabled: !cur, title: 'Play', on: { click: () => { if (!Sound.prefs().on) U.toast('Sounds are switched off in this browser (table sidebar → Effects).'); Sound.playUrl(cur.url, cur.volume, 'preview'); } } }, '▶'),
          h('button', { type: 'button', class: 'btn sm ghost danger', disabled: !cur, on: { click: async () => { cur = null; await onChange(null); draw(); } } }, 'Remove')),
        h('label', { class: 'snd-vol' }, h('span', { class: 'muted' }, 'Volume'), vol));
    }
    draw();
    return box;
  }

  async function render(el) {
    if (!App.me || !App.me.admin) {
      el.append(h('section', { class: 'page' }, h('h1', null, 'Admin'), h('p', { class: 'muted' }, 'Only admins can open this page.')));
      return;
    }
    let settings = {};
    try { settings = await App.backend.getSettings(); } catch (e) { U.toast(e.message, 'error'); }
    const save = async (key, value) => {
      try {
        await App.backend.saveSetting(key, value);
        settings[key] = value;
        await App.loadSettings();
        return true;
      } catch (e) { U.toast(e.message, 'error'); return false; }
    };

    // ----- card back -----
    const backBox = h('div', { class: 'admin-back' });
    const backFile = h('input', { type: 'file', id: 'ad-back', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true,
      on: { change: e => { useBack(e.target.files[0]); e.target.value = ''; } } });
    async function useBack(f) {
      if (!f || !/^image\//.test(f.type)) { U.toast("That isn't an image.", 'error'); return; }
      if (f.size > 15 * 1024 * 1024) { U.toast('That image is over 15 MB.', 'error'); return; }
      const r = await Cropper.open(f, { fullArt: true });
      if (!r) return;
      try {
        const url = await App.backend.uploadImage(r.file);
        if (await save('card_back', { url })) { U.toast('Card back saved.', 'good'); drawBack(); }
      } catch (e) { U.toast(e.message, 'error'); }
    }
    function drawBack() {
      const has = !!(settings.card_back && settings.card_back.url);
      backBox.replaceChildren(backFile,
        h('div', { class: 'admin-back-cards' },
          h('figure', null, Cards.renderBack('m'), h('figcaption', null, has ? 'Card back' : 'Built-in back')),
          h('figure', null, Cards.renderBack('m', '', { border: 'gold' }), h('figcaption', null, 'With a gold sleeve border'))),
        h('div', { class: 'stack' },
          h('p', { class: 'muted' }, 'Shown on every face-down card, deck and hand. A deck\'s own sleeve image still goes on top of it; a sleeve with only a border shows this back inside the border.'),
          h('div', { class: 'row wrap' },
            h('button', { class: 'btn primary', on: { click: () => backFile.click() } }, has ? 'Change image' : 'Upload image'),
            has ? h('button', { class: 'btn ghost danger', on: { click: async () => { if (await save('card_back', { url: null })) drawBack(); } } }, 'Use the built-in back') : null),
          h('p', { class: 'hint' }, 'PNG, JPG, WebP or GIF. You crop it to the card shape after choosing it. You can also drop an image here or paste one (Ctrl+V / ⌘V).')));
    }
    backBox.addEventListener('dragover', e => { e.preventDefault(); backBox.classList.add('drag'); });
    backBox.addEventListener('dragleave', () => backBox.classList.remove('drag'));
    backBox.addEventListener('drop', e => {
      e.preventDefault(); backBox.classList.remove('drag');
      const f = [...((e.dataTransfer && e.dataTransfer.files) || [])].find(x => /^image\//.test(x.type));
      if (f) useBack(f);
    });
    const onPaste = e => {
      if (document.body.dataset.view !== 'admin') return;
      if (document.querySelector('.modal')) return;
      const f = [...((e.clipboardData && e.clipboardData.items) || [])].filter(it => it.kind === 'file').map(it => it.getAsFile()).find(x => x && /^image\//.test(x.type));
      if (f) { e.preventDefault(); useBack(f); }
    };
    document.addEventListener('paste', onPaste);
    App.onLeave(() => document.removeEventListener('paste', onPaste));
    drawBack();

    // ----- sounds -----
    const sounds = { ...(settings.sounds || {}) };
    const rows = Sound.EVENTS.map(ev => h('div', { class: 'snd-row' },
      h('div', { class: 'snd-what' }, h('strong', null, ev.label), h('span', { class: 'hint' }, ev.help)),
      soundPicker(sounds[ev.id] || null, async v => {
        if (v) sounds[ev.id] = v; else delete sounds[ev.id];
        await save('sounds', { ...sounds });
      })));

    el.append(h('section', { class: 'page admin' },
      h('div', { class: 'page-head' }, h('h1', null, 'Admin'),
        h('p', { class: 'muted' }, 'Only admins see this page. Changes are for everyone: other players get them the next time they load the site.')),
      h('div', { class: 'panel' }, h('h2', null, 'Card back'), backBox),
      h('div', { class: 'panel' }, h('h2', null, 'Game sounds'),
        h('p', { class: 'muted' }, 'Pick a sound for each moment (MP3, OGG, WAV, M4A or WebM, up to 5 MB). Leave one empty for silence. Each player can turn sounds down or off for themselves in the table sidebar under Effects. Sounds for card animations are set on each animation (Card pool → Animations).'),
        h('div', { class: 'snd-list' }, rows))));
  }

  return { render, soundPicker, SOUND_TYPES };
})();
