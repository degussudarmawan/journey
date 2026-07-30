/* ============================================================================
   KEY PAGES — the world behind each door.
   ============================================================================

   One entry per key id, so each key can carry its own aesthetic and theme.
   Kept beside the key definitions rather than inside the page component so a
   new key is a data change, not a code change.
   ============================================================================ */

const PAGES = {
  lilac: {
    eyebrow: "The first door",
    title: "Lilac",
    blurb:
      "Placeholder for this key's world — swap in whatever this door should open onto.",
    background: "linear-gradient(160deg, #eceaf8 0%, #d8d7ef 100%)",
    ink: "#2b2a3a",
  },
};

const FALLBACK = {
  eyebrow: "Unlocked",
  title: "Untitled",
  blurb: "This key has no world behind it yet.",
  background: "#f4f4f8",
  ink: "#2b2b33",
};

export const keyPageTheme = (keyId) => PAGES[keyId] || FALLBACK;
