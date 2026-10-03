// Small helpers shared by every screen.
window.U = (() => {
  // h('div', {class: 'x', on: {click: fn}}, 'text', childEl, [more])
  // Text is always inserted as text (never HTML), so card text written by
  // friends can't inject code into the page.
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k === 'style' && typeof v === 'object') {
          for (const [p, val] of Object.entries(v)) {
            if (p.startsWith('--')) el.style.setProperty(p, val);
            else el.style[p] = val;
          }
        }
        else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    append(el, children);
    return el;
  }
  function append(el, children) {
    for (const c of children) {
      if (c == null || c === false) continue;
      if (Array.isArray(c)) append(el, c);
      else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
  }

  function uid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15);
      return (c === 'x' ? r : (r & 3) | 8).toString(16);
    });
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // JSON with sorted keys, so two copies of the same state compare equal
  // even after the database reorders their keys.
  function stable(o) {
    if (o === null || typeof o !== 'object') return JSON.stringify(o);
    if (Array.isArray(o)) return '[' + o.map(stable).join(',') + ']';
    return '{' + Object.keys(o).sort().filter(k => o[k] !== undefined).map(k => JSON.stringify(k) + ':' + stable(o[k])).join(',') + '}';
  }

  const clone = o => (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o)));

  let toastTimer;
  function toast(msg, kind = 'info') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast show ' + kind;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = 'toast'), 3200);
  }

  // Modal dialog. Returns {close, body}. Closes on backdrop click / Escape.
  function modal(title, content, { wide = false, onClose } = {}) {
    const root = document.getElementById('modal-root');
    const close = () => {
      wrap.remove();
      document.removeEventListener('keydown', onKey);
      onClose && onClose();
    };
    const onKey = e => { if (e.key === 'Escape') close(); };
    const body = h('div', { class: 'modal-body' }, content);
    const wrap = h('div', { class: 'modal-backdrop', on: { mousedown: e => { if (e.target === wrap) close(); } } },
      h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-label': title },
        h('div', { class: 'modal-head' },
          h('h2', null, title),
          h('button', { class: 'icon-btn', 'aria-label': 'Close', on: { click: close } }, '×')),
        body));
    root.append(wrap);
    document.addEventListener('keydown', onKey);
    return { close, body };
  }

  // In-page confirm (browser confirm() is blocked in some places).
  function ask(question, okLabel = 'Yes', danger = false) {
    return new Promise(resolve => {
      let done = false;
      const m = modal('Please confirm', [
        h('p', null, question),
        h('div', { class: 'row end' },
          h('button', { class: 'btn ghost', on: { click: () => { done = true; m.close(); resolve(false); } } }, 'Cancel'),
          h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), on: { click: () => { done = true; m.close(); resolve(true); } } }, okLabel)),
      ], { onClose: () => { if (!done) resolve(false); } });
    });
  }

  function timeAgo(iso) {
    const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }

  return { h, uid, shuffle, clone, stable, toast, modal, ask, timeAgo };
})();
