import { keyPageTheme } from "./keys/pages";

/**
 * The page revealed once a key has unlocked its door. Fades in over the open
 * doorway, so the canvas beneath keeps showing through until it lands.
 *
 * Intentionally a shell: each key is meant to have its own aesthetic, so the
 * per-key look lives in src/keys/pages.js and everything structural stays here.
 */
export default function KeyPage({ keyId, onBack }) {
  const theme = keyPageTheme(keyId);
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 24,
        background: theme.background,
        color: theme.ink,
        fontFamily: "'Playfair Display', serif",
        animation: "keypage-in 1.1s ease both",
      }}
    >
      <style>{`@keyframes keypage-in { from { opacity: 0 } to { opacity: 1 } }`}</style>
      <div
        style={{
          fontSize: 13,
          letterSpacing: "0.34em",
          textTransform: "uppercase",
          fontStyle: "italic",
          opacity: 0.7,
        }}
      >
        {theme.eyebrow}
      </div>
      <h1 style={{ fontSize: "clamp(40px, 8vw, 96px)", fontWeight: 900, margin: 0 }}>
        {theme.title}
      </h1>
      <p style={{ maxWidth: "46ch", textAlign: "center", lineHeight: 1.6, opacity: 0.75 }}>
        {theme.blurb}
      </p>
      <button
        type="button"
        onClick={onBack}
        style={{
          marginTop: 12,
          fontFamily: "inherit",
          fontStyle: "italic",
          fontSize: 12,
          letterSpacing: "0.28em",
          textTransform: "uppercase",
          color: theme.ink,
          background: "transparent",
          border: `1px solid ${theme.ink}55`,
          borderRadius: 999,
          padding: "10px 22px",
          cursor: "pointer",
        }}
      >
        Back
      </button>
    </div>
  );
}
