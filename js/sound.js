// Game sounds. Admins pick a sound for each moment in the Admin panel; each
// player can turn sounds down or off for themselves (table sidebar → Effects).
window.Sound = (() => {
  const EVENTS = [
    { id: 'match_start', label: 'Match begins', help: 'The clash at the start of a match.' },
    { id: 'dice', label: 'Dice roll', help: 'Rolling for who goes first, and the Roll dice button.' },
    { id: 'your_turn', label: 'Your turn', help: 'When it becomes your step, or the chain hands you the call.' },
    { id: 'card_played', label: 'Card played', help: 'Any card played. A card whose animation has its own sound plays that instead.' },
    { id: 'signature', label: 'Signature card', help: 'The Signature moment (when the card has no animation of its own).' },
    { id: 'effect_ask', label: 'Card effect asks you', help: 'Card code wants you to choose Do it / Skip.' },
    { id: 'fight_check', label: 'Fight check', help: 'Choosing Fight or Refuse.' },
    { id: 'showdown', label: 'Showdown', help: 'A showdown starts.' },
    { id: 'race_start', label: 'Race begins', help: 'The mini lanes merge into the Race.' },
    { id: 'victory', label: 'Match ends: you win', help: 'Plays with the victory animation for the winner.' },
    { id: 'defeat', label: 'Match ends: someone else wins', help: 'For everyone else. Empty = uses the win sound.' },
  ];

  let lib = {}; // event id → { url, name, volume }
  const setLibrary = sounds => { lib = sounds && typeof sounds === 'object' ? sounds : {}; };
  const get = id => lib[id] || null;

  function prefs() {
    try { return { on: true, volume: 0.8, ...JSON.parse(localStorage.getItem('uma-sound') || '{}') }; } catch (e) { return { on: true, volume: 0.8 }; }
  }
  function setPrefs(p) { try { localStorage.setItem('uma-sound', JSON.stringify(p)); } catch (e) { /* private mode */ } }

  const playing = new Map(); // key → Audio (so the same sound doesn't stack up)
  function playUrl(url, volume = 1, key = url) {
    const p = prefs();
    if (!url || !p.on || !(p.volume > 0)) return null;
    try {
      const old = playing.get(key);
      if (old) { old.pause(); playing.delete(key); }
      const a = new Audio(url);
      a.volume = Math.max(0, Math.min(1, (Number(volume) || 1) * p.volume));
      a.addEventListener('ended', () => { if (playing.get(key) === a) playing.delete(key); });
      const pr = a.play();
      if (pr && pr.catch) pr.catch(() => { /* blocked until the page is clicked, or a bad file */ });
      playing.set(key, a);
      return a;
    } catch (e) { return null; }
  }

  // Play the sound for a game moment (if one is set).
  function play(id) {
    const s = get(id) || (id === 'defeat' ? get('victory') : null);
    if (!s || !s.url) return null;
    return playUrl(s.url, s.volume ?? 1, 'event:' + id);
  }

  function stopAll() { for (const a of playing.values()) { try { a.pause(); } catch (e) { /* ignore */ } } playing.clear(); }

  return { EVENTS, setLibrary, get, play, playUrl, stopAll, prefs, setPrefs };
})();
