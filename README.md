# Uma TCG — friends-only online table

A browser game table for your TCG. Friends sign in, make cards, build decks,
challenge each other, and play on a shared table where the **players apply the
rules by hand** (like Cockatrice). The site keeps track of every card, counter,
phase and fan total, and shows both players the same table live.

It's plain HTML/CSS/JavaScript: no build step, no installs. It costs $0 to run:

- **GitHub Pages** hosts the files (the link your friends open).
- **Supabase** (free tier) handles sign-in, the friends whitelist, the card pool,
  card art, and live updates between players.

---

## 0. Try it first (2 minutes, no accounts)

Leave `js/config.js` as it is (empty keys) and open the game. It runs as an
**offline demo**: sample cards, two ready-made decks, and a pretend friend who
accepts every challenge. In a match, use **Viewing as** to play both sides.

To open it locally you need a tiny web server (browsers block some features on
`file://` pages). In this folder, run one of:

```
python -m http.server 8000      # then open http://localhost:8000
npx serve                       # if you have Node.js
```

Or skip this and go straight to step 2. GitHub Pages works in demo mode too.

---

## 1. Set up Supabase (the backend)

1. Go to <https://supabase.com>, sign up, and click **New project**. Pick any
   name and region, and a strong database password (you won't need it again).
   Wait a minute or two for it to finish setting up.
2. Open **SQL Editor → New query**. Paste all of `supabase/schema.sql` and
   press **Run**. You should see "Success. No rows returned."
3. **New query** again: paste all of `supabase/02-guest-codes.sql` → **Run**.
   (Files 03–07 are only for projects made before later updates; a new
   project already has everything from `schema.sql`. If yours is older, run
   any of 03–07 you haven't run yet, in order.)
4. **New query**: add yourself and your friends, and make yourself admin.
   Use the emails you'll sign in with:

   ```sql
   insert into public.allowed_emails (email) values
     ('you@example.com'),
     ('friend1@example.com');

   insert into public.admin_emails (email) values ('you@example.com');
   ```

   Run the first part again any time to add more friends.
5. **Authentication → Sign In / Providers**:
   - under **Email**, turn off **Confirm email** and save (Supabase's
     built-in email sender only sends a few emails an hour);
   - turn on **Allow anonymous sign-ins** and save (needed for guest codes).
6. **Project Settings → API Keys**: copy the **Project URL** and the
   **publishable key** (starts with `sb_publishable_`). Older projects may
   show a legacy **anon** key (starts with `eyJ`) instead; that works too.
   Don't use the *secret* / *service_role* key.
7. Open `js/config.js` in any text editor and paste them in:

   ```js
   SUPABASE_URL: 'https://abcdefgh.supabase.co',
   SUPABASE_ANON_KEY: 'sb_publishable_...',
   ```

   This key is meant to be public. The database rules only let people on
   your friends list see or change anything.

## 2. Put it on GitHub Pages (the link)

1. Make a GitHub account, then click **+ → New repository**. Name it, e.g.
   `uma-tcg`, leave it **Public** (free Pages needs that; nothing in the code
   is secret) and click **Create repository**.
2. On the new repo's page, click **uploading an existing file**. Open the
   unzipped `uma-tcg` folder and drag in **everything inside it** (`index.html`,
   `README.md`, and the `css`, `js` and `supabase` folders), not the outer
   folder itself. Click **Commit changes**.
3. Go to **Settings → Pages**. Under **Build and deployment**, set Source to
   **Deploy from a branch**, Branch **main**, folder **/ (root)**, and **Save**.
4. Wait a minute or two and refresh. The page shows your link, like
   `https://yourname.github.io/uma-tcg/`.

To update the site later, upload the changed files to the repo again (same
**Add file → Upload files**). It redeploys by itself in a minute or two.

## First run

1. Open your link and click **Create an account** with your admin email.
   Pick your display name.
2. Go to **Card pool → Import sample cards**. You now have 30 cards and two
   decks (*Gale Tempo*, *Granite Grind*).
3. Send friends the link. They create accounts with the emails you added.
   Friends without an email can use a **guest code** instead (Play tab).

### If something goes wrong

- **"Not on the list yet"** after signing in: that exact email isn't in
  `allowed_emails`. Add it (step 1.4) and sign in again.
- **No "Import sample cards" button**: your email isn't in `admin_emails`,
  or you signed in before adding it. Add it, sign out and back in.
- **The site still says "Offline demo"**: `js/config.js` on GitHub still has
  empty keys. Re-upload it, then wait a minute and hard-refresh.
- **"Could not reach the server"**: free Supabase projects pause after about
  a week without use. Open the Supabase dashboard and click **Restore**.
- **Guest code says sign-in failed**: anonymous sign-ins are off (step 1.5).

## 3. Play

- Everyone opens the link and creates an account with a whitelisted email.
  Anyone else can create an account but sees only a "not on the list" message.
- **Sample cards**: as an admin, open **Card pool** → **Import sample
  cards**. It adds the 30 demo cards plus the two demo decks (*Gale Tempo*
  and *Granite Grind*, owned by you) so you have something to play and
  balance right away. Safe to press twice: cards already in the pool are
  skipped.
- **Card maker**: make cards (art is optional, max 2 MB per image). The
  **Text modifiers** bar under the effect box inserts keyword badges and
  symbols at your cursor. You can also type them:

  | Type this | You get |
  |---|---|
  | `[Uma-Roar>]: Draw a card.` | a green UMA-ROAR badge with an arrow, then your text |
  | `[Friendship]` | a flat badge (no arrow) |
  | `[Anything]` | a grey badge for your own custom keyword |
  | `*(reminder text)*` | italics |
  | `{E2}` `{P1}` | energy / power cost symbols |
  | `{exhaust}` `{might}` `{star}` `{speed}` `{0}`–`{9}` `{->}` | symbols |

  Keywords you write into the text are tagged on the card automatically.
- **Rarity**: Common ●, Uncommon ◆, Rare ◆, Epic ⬢ or Signature ★, shown as
  a gem at the bottom of the card. Epic and Signature default to the
  **full-art frame** (the art fills the whole card, with a gold edge;
  Signature also gets a foil shine). Leaders are always full art. You can
  turn full art on or off for any card. The rarity list lives in
  `js/cards.js` (`RARITIES`) if you want to rename tiers, e.g. to Champion.
- **Subtitle** (optional): a smaller italic line under the name, like
  Riftbound champions. An Uma with a subtitle shows as a **Champion Uma**.
- **Tags**: Front Runner, Pace Chaser, Long Runner, End Closer. Shown in the
  type line. Add more in `js/cards.js` (`TAGS`).
- **Conjure**: when a card has the Conjure keyword, a **Conjure settings**
  panel appears: card type, Champion or not, energy and power cost
  (exactly / or less / or more), colors, tags, how many, and where they go.
  It shows how many pool cards match. In a match, right-click the card →
  **✦ Conjure** to create random matching cards. Works on cards in play, in
  your hand, and in your trash (for spells that already resolved).
- **Environments**: give a Trick the **Environment** keyword. In a match,
  play it with **Set environment: Mini lane 1/2** (or drag it onto a mini
  lane). It goes on the chain like any trick, then stays in that lane's
  environment slot and tints the lane. One per lane: a new one replaces the
  old, which goes to the trash. In the Race both environments show side by
  side and both apply. Effects are applied by hand, like everything else.
- **Tokens**: in a match, press **Token…** in the sidebar. Pick how many,
  whether they enter ready, and where they go (base or a lane). Built in:
  **Racer** (a 1-might Uma) and **Carrot** (gear: exhaust and trash it for
  1 Energy of any type, like Riftbound's Gold). Tokens have a silver frame.
  A token that would go to a hand, deck or trash is removed from the game
  instead. To add or change tokens, edit `TOKENS` in `js/cards.js`.
- **Costs and might**: energy is the number in the top-left circle; power is
  the column of type-colored Stars under it. Might is the ringed circle in the
  top-right corner.
- **Decks**: pick a Superhorse Uma leader, split the 12 Stars between its two
  types, and add cards that fit its types.
- **Play**: press **Challenge** next to a friend and pick a deck. They get the
  challenge live, pick their deck, and you're both dropped onto the table.

### Guest codes (no email needed)

On the Play tab, press **Make a guest code**, then pick your deck and the deck
your guest will use. You get a code like `MTR6-9ZVS` and a link with it filled
in. Send either one. Your friend opens the site, types a name, and lands
straight in a match against you. Stay on the site and the match opens for you
automatically.

- Each code works once and expires after 24 hours.
- Guests get their own copy of the preset deck, and can make cards and decks
  and challenge people like anyone else.
- A guest account lives in that browser. If they sign out or clear their
  browser data, they need a new code. Their old cards stay in the pool.

### On the table

| Do this | What happens |
|---|---|
| **Left-click** your card in play | Exhaust / ready it (it turns sideways) |
| **Left-click** the other player's card | Ping it (it flashes for both of you) |
| **Left-click** a card in your hand | Options for playing it (your hand is the fan at the bottom; hover to lift a card) |
| **Right-click** any card (long-press on touch) | All options: lanes, counters, target arrow, face-down, attach, trash, give… |
| **Right-click** your Star | Recycle it to the bottom of your Star deck |
| **Space** | Pass your Ramp step |
| **S** | Resolve the top of the chain (when it's your call) |
| **Click your deck** | Draw 1 (right-click: shuffle or look through it) |
| **Click Stars pile** | Channel 1 Star |
| **Click a trash pile** | Look at it; right-click a card inside for its options (✦ = can Conjure) |
| **Drag** (computer) | Move a card between zones |
| **Hover** any card | A big, readable copy appears right next to it |

Actions show up instantly on your screen and save in the background.

**The chain** (like Riftbound): every card you play goes on the chain first,
shown big on the right. The other player gets the call: they can respond with
a Reaction (it stacks on top and resolves first) or press **Resolve (S)**.
After each resolve, the call goes to whoever didn't play the new top card.
Units land on the table the moment you play them; they also appear on the
chain so the other player can respond or counter (countering trashes the
unit). Tricks wait on the chain and go to the trash when they resolve, and
Trainers attach when they resolve. Click a card on the chain to counter it, or take back
your own top card. Right-click a card in play → **Use ability** to put an
ability on the chain too. Face-down plays (In the Shadows) skip the chain.

**The turn bar** across the top shows whose turn it is, both players' fans,
and a track of the whole round: Ramp 1 (units → units & tricks → tricks),
Ramp 2 with the order switched, the end-of-Ramp fight check, then the Race.
A marker slides along it as you pass, and a "Your turn" splash plays when the
turn changes. The main button for the moment (Pass, Begin Race, End Race)
lives there too.

**Start of each Ramp is automatic:** both players ready all their cards and
Stars, channel 2 Stars, and draw 1. The log notes it, and Undo can reverse it.
- **Sidebar**: the phase tracker (Ramp steps → end of Ramp → Race), Draw 1,
  Channel 2, Ready all, Reveal hand, Conjure, Undo, and the table log.
- **Fans** live under each player's name with quick buttons (+50, +150…).
  Reaching 1000 ends the match.
- **Undo** reverses your own last action, as long as nobody has acted since.

Everything is logged, so if someone fumbles a rule you can see what happened.

---

## Settings you can change

All in `js/config.js`:

| Setting | Default | What it is |
|---|---|---|
| `DECK_SIZE` | 40 | Main deck size (deck builder warns, doesn't block) |
| `MAX_COPIES` | 3 | Copies of one card per deck (warning only) |
| `STAR_DECK_SIZE` | 12 | Stars per deck, split between the leader's two types |
| `STARTING_HAND` | 5 | Cards drawn at the start of a match |
| `STARS_PER_RAMP` | 2 | Stars channeled at the start of each Ramp |
| `RAMPS_PER_RACE` | 2 | Ramp phases before each Race (order switches every Ramp) |
| `USE_CHAIN` | true | Played cards go on the chain first (false = straight to the table) |
| `AUTO_START_OF_RAMP` | true | Auto ready + channel + draw at each Ramp start (false = do it by hand) |
| `ENVIRONMENTS_AFTER_RACE` | 'stay' | Environments stay until replaced ('stay') or all go to the trash after each Race ('trash') |
| `RETURN_UNITS_AFTER_RACE` | true | Units left in the Lane go back to base when the Race ends |

## Files

| File | What it does |
|---|---|
| `index.html` | The page that loads everything |
| `css/style.css` | All the styling |
| `js/config.js` | Your keys and game numbers |
| `js/cards.js` | Card types, keywords, and how cards are drawn |
| `js/game.js` | The match state and every table action (move, exhaust, counters…) |
| `js/table.js` | The game table screen |
| `js/views-cards.js` | Card pool and card maker |
| `js/views-decks.js` | Deck list and deck builder |
| `js/app.js` | Sign-in, navigation, friends list and challenges |
| `js/backend-supabase.js` | Talks to Supabase |
| `js/backend-demo.js` | The offline demo (sample cards live here) |
| `supabase/schema.sql` | Database tables and the friends-only rules |
| `supabase/02-guest-codes.sql` | Guest codes (run after schema.sql) |
| `supabase/03-rarity.sql` | Adds rarity + full art to an older database |
| `supabase/04-subtitle.sql` | Adds card subtitles to an older database |
| `supabase/05-tags-conjure.sql` | Adds tags + Conjure settings to an older database |
| `supabase/06-admins.sql` | Adds admins (edit any card) to an older database |
| `supabase/07-environments.sql` | Allows the Environment keyword on an older database |

## Good to know

- **Hidden info is honor-system.** Hands and deck order are hidden on screen,
  but the whole table state is sent to both players' browsers, so a friend
  poking around in developer tools could peek. Fine for friends. If it ever
  matters, the fix is moving hand data into a separate table only the owner
  can read.
- **Supabase pauses free projects** after about a week with no activity.
  If the site says it can't reach the server, open your Supabase dashboard
  and click **Restore project**.
- **Card art**: the bucket is public-read (anyone with an image's exact link
  can view it), but only whitelisted friends can upload.
- Use art you made or have permission to use, even for a private game.
