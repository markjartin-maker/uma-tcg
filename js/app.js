// App shell: login, navigation, and the Play (lobby) screen.
window.App = (() => {
  const { h } = U;
  const app = {
    backend: null,
    me: null,
    view: 'play',
    cleanup: [],          // unsubscribe functions for the current screen
    lobbyCleanup: [],     // challenge watcher stays on across screens
    opened: new Set(),    // accepted challenges we've already jumped into
  };

  const main = () => document.getElementById('view');

  async function start() {
    const c = window.CONFIG;
    document.title = c.APP_NAME;
    app.backend = c.SUPABASE_URL && c.SUPABASE_ANON_KEY && window.supabase
      ? new SupabaseBackend(c.SUPABASE_URL, c.SUPABASE_ANON_KEY)
      : new DemoBackend();
    try {
      app.me = await app.backend.init();
    } catch (e) {
      console.error(e);
      U.toast('Could not reach the server: ' + e.message, 'error');
    }
    renderTopbar();
    if (app.me && app.me.allowed) afterLogin();
    else renderAuth();
  }

  // ---------- top bar ----------
  function renderTopbar() {
    const bar = document.getElementById('topbar');
    bar.replaceChildren(
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }), window.CONFIG.APP_NAME,
        app.backend.mode === 'demo' ? h('span', { class: 'pill demo' }, 'Offline demo') : null),
      app.me && app.me.allowed ? h('nav', { class: 'tabs', 'aria-label': 'Sections' },
        [['play', 'Play'], ['cards', 'Card pool'], ['maker', 'Card maker'], ['decks', 'Decks']].map(([id, label]) =>
          h('button', { class: 'tab' + (app.view === id ? ' active' : ''), on: { click: () => go(id) } }, label))) : h('span'),
      app.me ? h('div', { class: 'me-box' },
        h('span', { class: 'me-name' }, app.me.name),
        app.me.guest ? h('span', { class: 'pill' }, 'Guest') : null,
        h('button', { class: 'btn ghost sm', on: { click: signOut } }, 'Sign out')) : h('span'),
    );
  }

  function go(view, arg) {
    Table.leave();
    app.cleanup.forEach(f => f());
    app.cleanup = [];
    app.view = view;
    document.body.dataset.view = view;
    renderTopbar();
    const el = main();
    el.replaceChildren();
    window.scrollTo(0, 0);
    if (view === 'play') renderLobby(el);
    else if (view === 'cards') CardViews.renderPool(el);
    else if (view === 'maker') CardViews.renderMaker(el, arg);
    else if (view === 'decks') DeckViews.render(el, arg);
    else if (view === 'match') Table.open(el, arg);
  }

  // ---------- auth ----------
  function renderAuth() {
    document.body.dataset.view = 'auth';
    const el = main();
    if (app.me && !app.me.allowed) {
      el.replaceChildren(h('section', { class: 'auth' },
        h('h1', null, 'Not on the list yet'),
        app.me.email
          ? h('p', null, 'You are signed in as ', h('strong', null, app.me.email), ', but this table is friends only. Ask whoever runs it to add that email to the friends list, then sign in again.')
          : h('p', null, 'Your guest pass is no longer active. Sign out, then ask a friend for a new code.'),
        h('button', { class: 'btn', on: { click: signOut } }, 'Sign out')));
      return;
    }
    if (app.backend.mode === 'demo') {
      const name = h('input', { id: 'demo-name', value: 'Player 1', maxlength: 32, autocomplete: 'nickname' });
      el.replaceChildren(h('section', { class: 'auth' },
        h('p', { class: 'eyebrow' }, 'Offline demo'),
        h('h1', null, 'Take a seat at the table'),
        h('p', null, 'Nothing is saved and nobody else can join. There are sample cards and two ready-made decks, and a pretend friend who accepts every challenge. In a match you can switch sides to play both players.'),
        h('p', { class: 'muted' }, 'Add your Supabase keys to js/config.js to play online with friends.'),
        h('label', { for: 'demo-name' }, 'Your name'), name,
        h('button', { class: 'btn primary', on: { click: async () => { app.me = await app.backend.signIn('', '', name.value.trim() || 'Player 1'); afterLogin(); } } }, 'Start demo')));
      return;
    }
    const urlCode = new URLSearchParams(location.search).get('code') || '';
    let mode = urlCode ? 'code' : 'in';
    const email = h('input', { id: 'auth-email', type: 'email', autocomplete: 'email', placeholder: 'you@example.com' });
    const pw = h('input', { id: 'auth-pw', type: 'password', autocomplete: 'current-password', minlength: 6 });
    const nm = h('input', { id: 'auth-name', maxlength: 32, autocomplete: 'nickname', placeholder: 'What friends see' });
    const code = h('input', { id: 'auth-code', maxlength: 12, autocomplete: 'off', placeholder: 'ABCD-2345', value: formatCode(urlCode), class: 'code-input' });
    const err = h('p', { class: 'form-error', role: 'alert' });
    const emailRow = h('div', { class: 'field' }, h('label', { for: 'auth-email' }, 'Email'), email);
    const pwRow = h('div', { class: 'field' }, h('label', { for: 'auth-pw' }, 'Password'), pw);
    const nameRow = h('div', { class: 'field' }, h('label', { for: 'auth-name' }, 'Display name'), nm);
    const codeRow = h('div', { class: 'field' }, h('label', { for: 'auth-code' }, 'Guest code'), code);
    const title = h('h1');
    const blurb = h('p', { class: 'muted' });
    const submit = h('button', { class: 'btn primary', type: 'submit' });
    const links = h('div', { class: 'auth-links' });

    function setMode(m) {
      mode = m;
      err.textContent = '';
      emailRow.hidden = pwRow.hidden = mode === 'code';
      nameRow.hidden = mode === 'in';
      codeRow.hidden = mode !== 'code';
      title.textContent = { in: 'Sign in to the table', up: 'Create an account', code: 'Join with a code' }[mode];
      blurb.textContent = mode === 'code'
        ? 'A friend gave you a code. No email needed: pick a name and you go straight to your match.'
        : 'For players on the friends list.';
      submit.textContent = { in: 'Sign in', up: 'Create account', code: 'Join the match' }[mode];
      pw.autocomplete = mode === 'in' ? 'current-password' : 'new-password';
      const opt = (m2, label) => h('button', { class: 'linkish', type: 'button', on: { click: () => setMode(m2) } }, label);
      links.replaceChildren(...{
        in: [opt('code', 'Have a guest code?'), opt('up', 'Create an account')],
        up: [opt('in', 'Have an account? Sign in'), opt('code', 'Have a guest code?')],
        code: [opt('in', 'Sign in with email instead')],
      }[mode]);
    }

    const form = h('form', { class: 'auth', on: { submit: async e => {
      e.preventDefault();
      err.textContent = '';
      submit.disabled = true;
      try {
        if (mode === 'code') {
          const c = code.value.replace(/[^a-z0-9]/gi, '').toUpperCase();
          if (c.length !== 8) throw new Error('Codes are 8 letters and numbers, like ABCD-2345.');
          if (!nm.value.trim()) throw new Error('Pick a display name.');
          const r = await app.backend.joinWithCode(c, nm.value.trim());
          app.me = r.me;
          history.replaceState(null, '', location.pathname);
          afterLogin();
          joinMatchFromCode(r.challengeId, r.deckId);
          return;
        }
        if (mode === 'in') app.me = await app.backend.signIn(email.value.trim(), pw.value);
        else {
          const r = await app.backend.signUp(email.value.trim(), pw.value, nm.value.trim() || email.value.split('@')[0]);
          if (r.needsConfirm) { err.textContent = 'Check your email to confirm the account, then sign in.'; submit.disabled = false; return; }
          app.me = r;
        }
        if (app.me.allowed) afterLogin(); else { renderTopbar(); renderAuth(); }
      } catch (e2) {
        err.textContent = e2.message;
      }
      submit.disabled = false;
    } } },
      h('p', { class: 'eyebrow' }, 'Friends only'),
      title, blurb, codeRow, emailRow, pwRow, nameRow, err, submit, links);
    el.replaceChildren(form);
    setMode(mode);
  }

  const formatCode = c => {
    const x = (c || '').replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 8);
    return x.length > 4 ? x.slice(0, 4) + '-' + x.slice(4) : x;
  };

  // The guest's browser accepts the host's challenge right away.
  async function joinMatchFromCode(challengeId, deckId) {
    try {
      U.toast('Setting up the table…');
      const list = await app.backend.listChallenges();
      const ch = list.find(c => c.id === challengeId);
      if (!ch) throw new Error('Could not find the match. Check the Play tab.');
      await acceptWith(ch, deckId);
    } catch (e) { U.toast(e.message, 'error'); }
  }

  async function signOut() {
    if (app.me && app.me.guest && app.me.allowed &&
      !(await U.ask('Guest accounts can\'t sign back in. You would need a new code to play again. Sign out anyway?', 'Sign out', true))) return;
    app.cleanup.forEach(f => f()); app.cleanup = [];
    app.lobbyCleanup.forEach(f => f()); app.lobbyCleanup = [];
    await app.backend.signOut();
    app.me = null;
    renderTopbar();
    renderAuth();
  }

  // Custom keywords (Keyword maker) are shared by everyone: load them once.
  async function loadKeywords() {
    try { Cards.setCustomKeywords(await app.backend.listKeywords()); } catch (e) { console.warn(e); }
  }

  async function loadAnimations() {
    try {
      const rows = await app.backend.listAnimations();
      for (const a of rows) if (a.kind === 'code' && a.code == null) a.code = Anim.CODE_TEMPLATE; // demo sample
      Anim.setLibrary(rows);
    } catch (e) { console.warn(e); }
  }

  function afterLogin() {
    loadKeywords();
    loadAnimations();
    // Challenges that were already accepted before this page loaded are old:
    // don't jump into those matches (they're listed under "Your matches").
    firstChallengeList = true;
    // Listen for challenges everywhere, so a challenge pops up on any screen.
    app.lobbyCleanup.push(app.backend.watchChallenges(onChallenges));
    go('play');
  }

  // ---------- challenges ----------
  let challenges = [];
  let profiles = [];
  let online = new Set();
  const seenIncoming = new Set();
  let firstChallengeList = true;

  async function onChallenges(list) {
    challenges = list;
    if (firstChallengeList) {
      firstChallengeList = false;
      for (const ch of list) if (ch.status === 'accepted') app.opened.add(ch.id);
    }
    const known = id => profiles.some(p => p.id === id);
    if (!profiles.length || list.some(c => !known(c.from_user) || !known(c.to_user))) profiles = await app.backend.listProfiles();
    for (const ch of list) {
      // My challenge was accepted → jump into the match.
      if (ch.status === 'accepted' && ch.match_id && ch.from_user === app.me.id && !app.opened.has(ch.id)) {
        app.opened.add(ch.id);
        U.toast(`${who(ch.to_user)} accepted! Opening the table…`, 'good');
        go('match', ch.match_id);
      }
      if (ch.status === 'pending' && ch.to_user === app.me.id && !seenIncoming.has(ch.id)) {
        seenIncoming.add(ch.id);
        if (app.view !== 'play') U.toast(`${who(ch.from_user)} challenged you! Open Play to answer.`, 'good');
      }
    }
    if (app.view === 'play') { drawLobbyLists(); drawInvites(); }
  }

  const who = id => (profiles.find(p => p.id === id) || {}).display_name || 'Someone';

  async function pickDeck(title, actionLabel) {
    const decks = (await app.backend.listDecks()).filter(d => d.owner === app.me.id);
    if (!decks.length) {
      U.toast('Build a deck first (Decks tab).', 'error');
      return null;
    }
    const cards = await app.backend.listCards();
    return new Promise(resolve => {
      let picked = false;
      const m = U.modal(title, [
        h('p', { class: 'muted' }, 'Pick the deck you want to play.'),
        h('div', { class: 'deck-pick' }, decks.map(d => {
          const leader = cards.find(c => c.id === d.leader_id);
          const count = Object.values(d.cards || {}).reduce((a, b) => a + b, 0);
          const warn = DeckViews.problems(d, cards);
          return h('button', { class: 'deck-option', on: { click: () => { picked = true; m.close(); resolve(d.id); } } },
            leader ? Cards.render(leader, { size: 's' }) : h('div', { class: 'card card-back sz-s' }),
            h('div', null,
              h('strong', null, d.name),
              h('div', { class: 'muted' }, `${count} cards${leader ? ' · ' + leader.name : ' · no leader'}`),
              warn.length ? h('div', { class: 'warn-text' }, warn[0]) : null),
            h('span', { class: 'btn primary sm' }, actionLabel));
        })),
      ], { onClose: () => { if (!picked) resolve(null); } });
    });
  }

  async function challenge(userId) {
    const deckId = await pickDeck(`Challenge ${who(userId)}`, 'Send');
    if (!deckId) return;
    try {
      await app.backend.sendChallenge(userId, deckId);
      U.toast(`Challenge sent to ${who(userId)}.`, 'good');
    } catch (e) { U.toast(e.message, 'error'); }
  }

  async function accept(ch) {
    const deckId = await pickDeck(`${who(ch.from_user)} challenged you`, 'Play');
    if (!deckId) return;
    try {
      U.toast('Setting up the table…');
      await acceptWith(ch, deckId);
    } catch (e) { U.toast(e.message, 'error'); }
  }

  async function acceptWith(ch, deckId) {
    const built = await Game.buildMatch(app.backend, ch, deckId);
    const matchId = await app.backend.createMatch(built);
    await app.backend.updateChallenge(ch.id, { status: 'accepted', match_id: matchId });
    app.opened.add(ch.id);
    go('match', matchId);
  }

  // ---------- lobby ----------
  let lobbyEls = null;

  async function renderLobby(el) {
    lobbyEls = {
      friends: h('ul', { class: 'friend-list' }),
      incoming: h('div', { class: 'stack' }),
      matches: h('div', { class: 'stack' }),
      invites: h('div', { class: 'stack' }),
    };
    el.append(h('div', { class: 'lobby' },
      h('section', { class: 'panel' },
        h('h2', null, 'Friends'),
        h('p', { class: 'muted' }, 'Everyone on the friends list. A green dot means they have the site open.'),
        lobbyEls.friends),
      h('section', { class: 'panel' },
        h('h2', null, 'Challenges'),
        lobbyEls.incoming),
      h('section', { class: 'panel' },
        h('h2', null, 'Your matches'),
        lobbyEls.matches),
      app.me.guest ? null : h('section', { class: 'panel' },
        h('h2', null, 'Invite a guest'),
        h('p', { class: 'muted' }, 'For a friend without an account. They enter the code and a name, and start a match against you with the deck you pick. Each code works once, for 24 hours.'),
        h('button', { class: 'btn primary', on: { click: makeInvite } }, 'Make a guest code'),
        lobbyEls.invites),
    ));
    drawInvites();
    profiles = await app.backend.listProfiles();
    app.cleanup.push(app.backend.watchPresence(set => { online = set; drawLobbyLists(); }));
    drawLobbyLists();
  }

  // ---------- guest codes ----------
  const inviteLink = c => `${location.origin}${location.pathname}?code=${c}`;

  async function copyText(text, input) {
    try { await navigator.clipboard.writeText(text); U.toast('Copied.', 'good'); }
    catch (e) { if (input) { input.focus(); input.select(); } U.toast('Press Ctrl+C (or Cmd+C) to copy.'); }
  }

  async function makeInvite() {
    const [decks, cards] = await Promise.all([app.backend.listDecks(), app.backend.listCards()]);
    const mine = decks.filter(d => d.owner === app.me.id);
    if (!mine.length) { U.toast('Build a deck first (Decks tab).', 'error'); return; }
    const label = d => {
      const l = cards.find(c => c.id === d.leader_id);
      return `${d.name}${l ? ' · ' + l.name : ''}${d.owner !== app.me.id ? ' (by ' + who(d.owner) + ')' : ''}`;
    };
    const hostSel = h('select', { id: 'inv-host' }, mine.map(d => h('option', { value: d.id }, label(d))));
    const guestSel = h('select', { id: 'inv-guest' }, decks.map(d => h('option', { value: d.id }, label(d))));
    if (decks.length > 1) guestSel.value = (decks.find(d => d.id !== mine[0].id) || decks[0]).id;
    const err = h('p', { class: 'form-error' });
    const m = U.modal('Make a guest code', h('div', { class: 'stack' },
      h('div', { class: 'field' }, h('label', { for: 'inv-host' }, 'Your deck'), hostSel),
      h('div', { class: 'field' }, h('label', { for: 'inv-guest' }, "Guest's deck"), guestSel,
        h('p', { class: 'hint' }, 'The guest gets their own copy of this deck.')),
      err,
      h('div', { class: 'row end' }, h('button', { class: 'btn primary', on: { click: async e => {
        e.currentTarget.disabled = true;
        try {
          const c = await app.backend.createInvite(hostSel.value, guestSel.value);
          m.close();
          showInvite(c);
          drawInvites();
        } catch (e2) { err.textContent = e2.message; e.currentTarget.disabled = false; }
      } } }, 'Make code'))));
  }

  function showInvite(c) {
    const link = h('input', { id: 'inv-link', readonly: true, value: inviteLink(c) });
    U.modal('Guest code ready', h('div', { class: 'stack' },
      h('div', { class: 'big-code' }, formatCode(c)),
      h('p', { class: 'muted' }, 'Send your friend the code, or the link (it fills in the code for them). Stay on the site: the match opens for you as soon as they join.'),
      h('div', { class: 'field' }, h('label', { for: 'inv-link' }, 'Link'), link),
      h('div', { class: 'row' },
        h('button', { class: 'btn', on: { click: () => copyText(formatCode(c)) } }, 'Copy code'),
        h('button', { class: 'btn primary', on: { click: () => copyText(inviteLink(c), link) } }, 'Copy link')),
      app.backend.mode === 'demo' ? h('p', { class: 'warn-text' }, 'This is the offline demo, so nobody can actually join with it. Codes work once the site is online.') : null));
  }

  async function drawInvites() {
    if (!lobbyEls || !lobbyEls.invites || app.me.guest) return;
    let list = [];
    try { list = await app.backend.listInvites(); } catch (e) { /* guest codes not set up yet */ }
    lobbyEls.invites.replaceChildren(...list.map(i => h('div', { class: 'challenge out' },
      h('button', { class: 'linkish code-link', on: { click: () => showInvite(i.code) } }, formatCode(i.code)),
      h('span', { class: 'muted' }, 'unused'),
      h('button', { class: 'btn ghost sm', on: { click: async () => { await app.backend.deleteInvite(i.code); drawInvites(); } } }, 'Delete'))));
  }

  async function drawLobbyLists() {
    if (!lobbyEls || app.view !== 'play') return;
    const others = profiles.filter(p => p.id !== app.me.id);
    lobbyEls.friends.replaceChildren(...(others.length ? others.map(p => h('li', null,
      h('span', { class: 'dot' + (online.has(p.id) ? ' on' : ''), title: online.has(p.id) ? 'Online' : 'Offline' }),
      h('span', { class: 'friend-name' }, p.display_name),
      h('button', { class: 'btn sm', on: { click: () => challenge(p.id) } }, 'Challenge'))) : [h('li', { class: 'muted' }, 'No friends have signed in yet.')]));

    const mine = challenges.filter(c => c.status === 'pending');
    lobbyEls.incoming.replaceChildren(...(mine.length ? mine.map(ch => ch.to_user === app.me.id
      ? h('div', { class: 'challenge in' },
        h('span', null, h('strong', null, who(ch.from_user)), ' challenges you'),
        h('div', { class: 'row' },
          h('button', { class: 'btn ghost sm', on: { click: () => app.backend.updateChallenge(ch.id, { status: 'declined' }) } }, 'Decline'),
          h('button', { class: 'btn primary sm', on: { click: () => accept(ch) } }, 'Accept')))
      : h('div', { class: 'challenge out' },
        h('span', null, 'Waiting for ', h('strong', null, who(ch.to_user)), '…'),
        h('button', { class: 'btn ghost sm', on: { click: () => app.backend.updateChallenge(ch.id, { status: 'cancelled' }) } }, 'Cancel')))
      : [h('p', { class: 'muted' }, 'No open challenges. Press Challenge next to a friend to start one.')]));

    const matches = await app.backend.listMatches();
    lobbyEls.matches.replaceChildren(...(matches.length ? matches.map(m => {
      const other = m.p1 === app.me.id ? m.p2 : m.p1;
      return h('div', { class: 'match-row' },
        h('span', null, 'vs ', h('strong', null, who(other))),
        h('span', { class: 'pill ' + (m.status === 'active' ? 'live' : '') }, m.status === 'active' ? 'In progress' : 'Finished'),
        h('button', { class: 'btn sm', on: { click: () => go('match', m.id) } }, 'Open'));
    }) : [h('p', { class: 'muted' }, 'No matches yet.')]));
  }

  return { start, go, loadKeywords, loadAnimations, get backend() { return app.backend; }, get me() { return app.me; }, who: id => who(id), refreshProfiles: async () => { profiles = await app.backend.listProfiles(); } };
})();

document.addEventListener('DOMContentLoaded', () => App.start());
