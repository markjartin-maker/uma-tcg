// =====================================================================
// Settings — this is the only file you need to edit to go live.
// =====================================================================
window.CONFIG = {
  // From Supabase → Project Settings → API Keys.
  // SUPABASE_URL looks like https://abcdefgh.supabase.co
  // SUPABASE_ANON_KEY: the "publishable" key (starts with sb_publishable_)
  // or, on older projects, the legacy "anon" key (starts with eyJ). Both
  // are safe to put here. NEVER put the secret / service_role key here.
  // Leave both empty to run the offline demo (you control both players).
  SUPABASE_URL: 'https://cmritujdyptezhhjxpxc.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_U8F0HxjptnXKxz3_MjFivw_6612j326',

  APP_NAME: 'Uma TCG',

  // Game numbers your rules doc doesn't pin down yet. Change freely.
  GAME: {
    DECK_SIZE: 40,        // main deck size (warning only, not enforced)
    MAX_COPIES: 3,        // copies of one card per deck (warning only)
    STAR_DECK_SIZE: 12,   // stars split between the leader's two types
    STARTING_HAND: 5,     // cards drawn when a match starts
    STARS_PER_RAMP: 2,    // "Channel 2 Stars"
    RAMPS_PER_RACE: 2,    // Ramp phases before each Race (order switches each Ramp)
    // At the start of every Ramp, both players automatically ready all their
    // cards and Stars, channel STARS_PER_RAMP Stars, and draw 1 card.
    AUTO_START_OF_RAMP: true,
    // Riftbound-style chain: every card played (and abilities you choose to
    // use) goes on the chain; the other player can respond or resolve.
    // Set to false to play cards straight onto the table.
    USE_CHAIN: true,
    FANS_TO_WIN: 1000,
    MINI_LANE_FANS: 50,   // holding a mini lane at end of Ramp
    RACE_FANS: 150,       // only your units left at end of Race
    // After a Race ends, units still in the Lane go back to their owner's base.
    // Set to false to leave them in the Lane and move them by hand.
    RETURN_UNITS_AFTER_RACE: true,
    // Environments stay on their mini lane until replaced ('stay'),
    // or all go to the trash when a Race ends ('trash').
    ENVIRONMENTS_AFTER_RACE: 'stay',
  },
};
