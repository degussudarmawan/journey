import { useEffect, useRef, useState } from "react";
import { SpiralEngine, DEFAULT_PALETTE } from "./spiralEngine";
import { SketchLayer } from "./sketchLayer";

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
  const sketchCanvasRef = useRef(null);
  const trackRef = useRef(null);
  const hintRef = useRef(null);
  const engineRef = useRef(null);
  const sketchRef = useRef(null);

  // Whether the doodle layer is currently accepting strokes (only once the
  // starburst has fully settled). This is real UI state — it changes maybe
  // twice a scroll, not 60 times a second like particle positions — so
  // unlike the animation itself, useState is the right tool here: it drives
  // the Clear button's visibility declaratively instead of fighting React
  // for control of the DOM via an imperative style mutation.
  const [canDraw, setCanDraw] = useState(false);

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

    // The doodle layer only accepts new strokes once the starburst has
    // fully settled (the last stage) — mid-transition drawing would be
    // fighting with dots that are still moving into place.
    const isStarHold = () => {
      const eng = engineRef.current;
      if (!eng || !eng.stageDefs) return false;
      return eng.getStage(eng.scrollT).kind === "starHold";
    };
    const sketch = new SketchLayer(sketchCanvasRef.current, isStarHold);
    sketchRef.current = sketch;
    sketch.mount();

    // Keeps the Clear button's visibility (canDraw) in sync with scroll —
    // same underlying check as isStarHold above, just also pushed into
    // React state so the button can be styled declaratively.
    const onScroll = () => setCanDraw(isStarHold());
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    return () => {
      engine.unmount();
      engineRef.current = null;
      sketch.unmount();
      sketchRef.current = null;
      window.removeEventListener("scroll", onScroll);
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
          {/* Doodle layer: sits underneath the particle canvas, so marks
              show through the gaps between dots, like the star is drawn on
              top of a page the user has been scribbling on. Only accepts
              new strokes once SketchLayer's isActive() says so (see the
              mount effect above) — active or not, it's harmless to have it
              here since it only ever reacts to pointer events. */}
          <canvas
            ref={sketchCanvasRef}
            style={{
              position: "absolute",
              inset: 0,
              display: "block",
              width: "100%",
              height: "100%",
            }}
          />
          <canvas
            ref={canvasRef}
            style={{
              position: "absolute",
              inset: 0,
              display: "block",
              width: "100%",
              height: "100%",
            }}
          />
          <button
            type="button"
            onClick={() => sketchRef.current?.clear()}
            style={{
              position: "absolute",
              bottom: 28,
              right: 28,
              opacity: canDraw ? 1 : 0,
              pointerEvents: canDraw ? "auto" : "none",
              transition: "opacity .2s linear",
              fontFamily: "'Playfair Display', serif",
              fontStyle: "italic",
              fontWeight: 600,
              fontSize: 12,
              letterSpacing: "0.28em",
              textTransform: "uppercase",
              color: "oklch(40% 0.02 260)",
              background: "oklch(98.5% 0.003 260 / 0.7)",
              border: "1px solid oklch(40% 0.02 260 / 0.35)",
              borderRadius: 999,
              padding: "8px 18px",
              cursor: "pointer",
            }}
          >
            Clear
          </button>
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
