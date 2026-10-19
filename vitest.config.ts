import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// "source": resolve the package's own name to src/ (examples import it by name).
// react-native: minimal host components, so `./react` is tested without a native toolchain.
const reactNative = fileURLToPath(new URL('./test/mocks/react-native.ts', import.meta.url));
export default defineConfig({
  resolve: { conditions: ['source'], alias: { 'react-native': reactNative } },
  ssr: { resolve: { conditions: ['source'] } },
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
