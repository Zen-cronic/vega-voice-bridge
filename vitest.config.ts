import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// "source": resolve the package's own name to src/ (examples import it by name).
// react-native: minimal host components, so `./react` is tested without a native toolchain.
// @amazon-devices/react-native-w3cmedia: see below.
const reactNative = fileURLToPath(new URL('./test/mocks/react-native.ts', import.meta.url));
// The Vega media player: a scriptable stand-in, so `./vega` is tested without a Vega device.
const w3cmedia = fileURLToPath(new URL('./test/mocks/w3cmedia.ts', import.meta.url));
export default defineConfig({
  resolve: { conditions: ['source'], alias: { 'react-native': reactNative, '@amazon-devices/react-native-w3cmedia': w3cmedia } },
  ssr: { resolve: { conditions: ['source'] } },
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
