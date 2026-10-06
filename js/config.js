// =====================================================================
// Game settings. (Your Supabase keys go in js/keys.js.)
// =====================================================================
window.CONFIG = {
  // Your Supabase keys live in js/keys.js (not in this file), so updates
  // to this file never wipe them. Empty keys = offline demo.
  SUPABASE_URL: (window.KEYS || {}).SUPABASE_URL || '',
  SUPABASE_ANON_KEY: (window.KEYS || {}).SUPABASE_ANON_KEY || '',

  APP_NAME: 'Uma TCG',

  // Game numbers your rules doc doesn't pin down yet. Change freely.
  GAME: {
    DECK_SIZE: 40,        // main deck size (warning only, not enforced)
    MAX_COPIES: 3,        // copies of one card per deck (warning only)
    STAR_DECK_SIZE: 12,   // stars split between the leader's two types
    STARTING_HAND: 5,     // cards drawn when a match starts
    STARS_PER_RAMP: 2,    // "Channel 2 Stars"
    RAMPS_PER_RACE: 3,    // Ramp phases before each Race (order switches each Ramp)
    // Fight check: always after the last Ramp. From round MID_FIGHT_FROM_ROUND
    // on (i.e. after the first Race), also one after Ramp MID_FIGHT_AFTER_RAMP.
    // Set MID_FIGHT_AFTER_RAMP to 0 to turn the extra check off.
    MID_FIGHT_AFTER_RAMP: 2,
    MID_FIGHT_FROM_ROUND: 2,
    REFUSE_FIGHT_FANS: 50, // fans lost for refusing a fight
    // Units moved between base and lanes become exhausted automatically.
    EXHAUST_ON_MOVE: true,
    SIGNATURES_PER_DECK: 3, // max Signature cards (of your Champion) per deck
    // At the start of every Ramp, both players automatically ready all their
    // cards and Stars, channel STARS_PER_RAMP Stars, and draw 1 card.
    AUTO_START_OF_RAMP: true,
    // Riftbound-style chain: every card played (and abilities you choose to
    // use) goes on the chain; the other player can respond or resolve.
    // Set to false to play cards straight onto the table.
    USE_CHAIN: true,
    FANS_TO_WIN: 1000,
    MINI_LANE_FANS: 50,   // fans per mini lane you hold
    // Holding: when your Units (or Units & tricks) step begins, you get
    // MINI_LANE_FANS for each mini lane where only your cards are.
    AUTO_HOLD_FANS: true,
    // A hold that would reach FANS_TO_WIN doesn't score: a showdown starts at
    // the opponent's next Units step instead. Win it to get the fans.
    SHOWDOWN: true,
    // Floating Energy / Power empties at the start of each Ramp.
    FLOAT_CLEARS_EACH_RAMP: true,
    RACE_FANS: 150,       // only your units left at end of Race
    // After a Race ends, units still in the Lane go back to their owner's base.
    // Set to false to leave them in the Lane and move them by hand.
    RETURN_UNITS_AFTER_RACE: true,
    // Environments all go to the trash when a Race ends ('trash'),
    // or stay on their mini lane until replaced ('stay').
    ENVIRONMENTS_AFTER_RACE: 'trash',
  },
};
