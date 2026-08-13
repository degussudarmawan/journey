import { useEffect, useRef, useState } from "react";
import { SpiralEngine, DEFAULT_PALETTE } from "./spiralEngine";
import { SketchLayer } from "./sketchLayer";
import { Door3D } from "./door3d";
import { DotsGL } from "./dotsGL";
import KeyPage from "./KeyPage";

/**
 * Scroll-driven dot animation: a resting grid explodes into a spiral, spells
 * out word1/word2/word3/word4 one at a time, reforms into an eight-point
 * starburst that reacts to the cursor, and finally breaks apart into six
 * needle rays orbiting the centre on a tilted 3D track. See spiralEngine.js
 * for how it works and what to tweak.
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
  const doorLayerRef = useRef(null);
  const dotsLayerRef = useRef(null);
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
  // Set once a key's door has finished opening; holds that key's id.
  const [unlockedKey, setUnlockedKey] = useState(null);

  // How many words are actually active (mirrors the filtering rebuildWords()
  // does in spiralEngine.js) — used to size the scroll track so each word
  // gets roughly the same amount of scroll distance no matter how many
  // there are.
  const wordCount =
    [word1, word2, word3, word4].filter(
      (w) => typeof w === "string" && w.trim().length > 0,
    ).length || 3;
  // + 200vh for the closing star -> orbit act, so adding it didn't squeeze
  // every earlier stage into less scroll than before.
  const trackHeightVh = 100 + wordCount * 200 + 200;

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
    // Fires when the door has finished swinging open.
    engine.onUnlocked = (keyId) => setUnlockedKey(keyId ?? "unknown");

    // The door is real 3D geometry on its own WebGL canvas behind the dots.
    // If a context can't be created, engine.door3d stays null and the 2D
    // strip-based door in door.js draws instead — same sequence, flatter.
    const door3d = new Door3D(doorLayerRef.current);
    if (door3d.mount()) engine.door3d = door3d;

    // Dots render as WebGL points by default. This is what lets the key be a
    // real mesh sharing their depth buffer instead of a flat shape painted
    // between whole pieces — see dotsGL.js.
    //
    // Canvas2D remains as an automatic fallback: if mount() fails there's no
    // WebGL context to be had, engine.dotsGL stays null, and the 2D path takes
    // over on its own. `?dots=2d` forces it for side-by-side comparison.
    let dotsGL = null;
    if (new URLSearchParams(window.location.search).get("dots") !== "2d") {
      dotsGL = new DotsGL(dotsLayerRef.current);
      if (dotsGL.mount()) engine.dotsGL = dotsGL;
    }

    engine.mount();

    // Sketching is parked for now — it's headed for one of the key pages
    // instead of the main scroll. Leaving the layer mounted (just never
    // active) keeps it a one-line change to bring back, and keeps it from
    // fighting the orbit, where a click now picks a spike to turn into a key.
    const isSketchable = () => false;
    const sketch = new SketchLayer(sketchCanvasRef.current, isSketchable);
    sketchRef.current = sketch;
    sketch.mount();

    // Keeps the Clear button's visibility (canDraw) in sync with scroll —
    // same underlying check as isSketchable above, just also pushed into
    // React state so the button can be styled declaratively.
    const onScroll = () => setCanDraw(isSketchable());
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    return () => {
      engine.unmount();
      engineRef.current = null;
      door3d.unmount();
      dotsGL?.unmount();
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
        // background: "oklch(98.5% 0.003 260)",
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
          {/* Door layer: the backmost element, so the dots, the key and the
              doodles all draw over the top of it. Empty here on purpose —
              Door3D creates its own WebGL canvas inside this box and fades
              the whole layer in via CSS opacity, which is one compositor
              property instead of a transparency pass over every material. */}
          <div
            ref={doorLayerRef}
            style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
          />
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
          {/* Prototype dot layer (?dots=gl). Sits directly under the 2D
              particle canvas, which draws nothing in the stages GL has taken
              over — only one of the two is ever producing dots. */}
          <div
            ref={dotsLayerRef}
            style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
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
      {unlockedKey && (
        <KeyPage
          keyId={unlockedKey}
          onBack={() => {
            // Reset the engine too, or the door stays open on the canvas
            // behind the page we're dismissing.
            engineRef.current?.resetUnlock();
            setUnlockedKey(null);
          }}
        />
      )}
    </div>
  );
}
