import { useEffect, useRef } from "react";
import { SpiralEngine, DEFAULT_PALETTE } from "./spiralEngine";

/**
 * Scroll-driven dot animation: a resting grid explodes into a spiral, spells
 * out word1/word2/word3/word4 one at a time, then reforms into an eight-point
 * starburst that reacts to the cursor. See spiralEngine.js for how it works
 * and what to tweak.
 *
 * All the heavy lifting (canvas drawing, requestAnimationFrame loop, scroll
 * listener) is deliberately kept in SpiralEngine, a plain JS class, rather
 * than in React state — this is a per-frame imperative animation, not
 * something that should re-render the component tree 60 times a second.
 * This component's only job is to hand the engine its DOM nodes and keep it
 * pointed at the latest props.
 */
export default function Spiral({
  word1 = "less",
  word2 = "is",
  word3 = "more",
  word4, // optional — leave unset and the star forms right after word3
  rotationSpeed = 0.16,
  accentPalette = DEFAULT_PALETTE,
  raySway = 0.14,
  cursorRepel = 1,
}) {
  const canvasRef = useRef(null);
  const trackRef = useRef(null);
  const hintRef = useRef(null);
  const engineRef = useRef(null);

  // How many words are actually active (mirrors the filtering rebuildWords()
  // does in spiralEngine.js) — used to size the scroll track so each word
  // gets roughly the same amount of scroll distance no matter how many
  // there are.
  const wordCount =
    [word1, word2, word3, word4].filter(
      (w) => typeof w === "string" && w.trim().length > 0,
    ).length || 3;
  const trackHeightVh = 100 + wordCount * 200;

  // "Latest props" ref: the render loop reads props.current every frame
  // instead of closing over a stale value, so prop changes take effect
  // immediately without needing to restart the engine.
  const props = {
    word1,
    word2,
    word3,
    word4,
    rotationSpeed,
    accentPalette,
    raySway,
    cursorRepel,
  };
  const propsRef = useRef(props);
  propsRef.current = props;

  // Mount once: build the engine and start it. Cleans itself up on unmount.
  useEffect(() => {
    const engine = new SpiralEngine(
      canvasRef.current,
      trackRef.current,
      hintRef.current,
      () => propsRef.current,
    );
    engineRef.current = engine;
    engine.mount();
    return () => {
      engine.unmount();
      engineRef.current = null;
    };
  }, []);

  // Re-sample the word point clouds when any word prop changes (skipping the
  // very first run, since mount() already samples them once fonts are ready).
  const isFirstWordEffect = useRef(true);
  useEffect(() => {
    if (isFirstWordEffect.current) {
      isFirstWordEffect.current = false;
      return;
    }
    engineRef.current?.setWords();
  }, [word1, word2, word3, word4]);

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        background: "oklch(98.5% 0.003 260)",
      }}
    >
      <div ref={trackRef} style={{ height: `${trackHeightVh}vh`, position: "relative" }}>
        <div
          style={{
            position: "sticky",
            top: 0,
            height: "100vh",
            width: "100%",
            overflow: "hidden",
          }}
        >
          <canvas
            ref={canvasRef}
            style={{ display: "block", width: "100%", height: "100%" }}
          />
          <div
            ref={hintRef}
            style={{
              position: "absolute",
              top: 44,
              left: 0,
              right: 0,
              textAlign: "center",
              fontFamily: "'Playfair Display', serif",
              fontStyle: "italic",
              fontWeight: 600,
              fontSize: 13,
              letterSpacing: "0.32em",
              textTransform: "uppercase",
              color: "oklch(40% 0.02 260)",
              pointerEvents: "none",
              transition: "opacity .2s linear",
            }}
          >
            Scroll
          </div>
        </div>
      </div>
    </div>
  );
}
