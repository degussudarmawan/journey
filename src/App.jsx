import Spiral from './Spiral';

// Props here map 1:1 to spiralEngine.js's customization guide — change these
// defaults directly, or lift them into your own controls (a settings panel,
// URL params, etc.) if you want them adjustable at runtime.
export default function App() {
  return (
    <Spiral
      word1="less"
      word2="is"
      word3="more"
      word4=">.<"
      rotationSpeed={0.16}
      accentPalette={['#2a2a2f']}
      // accentPalette={['#f1f10e']}
      // accentPalette={['#c98a8a', '#8aa8c9', '#8ec9a6', '#b98ac9']}
      raySway={0.14}
      cursorRepel={1}
    />
  );
}
