/* ============================================================================
   KEY REGISTRY — which star spike unlocks which key.
   ============================================================================

   Keyed by index into starTips() in spiralEngine.js:
     0:-137°  1:-90°  2:-47°  3:0°  4:43°  5:90°  6:136°  7:180°

   Spike 5 is the long bottom ray. Spikes with no entry here stay inert when
   clicked — add a module per key as each one's design is settled, so every
   key can carry its own palette, ornament and (later) its own destination
   page.
   ============================================================================ */

import { lilacKey } from "./lilacKey";

export const KEY_BY_SPIKE = {
  5: lilacKey,
};

export const keyForSpike = (spikeIdx) => KEY_BY_SPIKE[spikeIdx] || null;
