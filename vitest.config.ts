import { defineConfig } from 'vitest/config';

// "source": resolve the package's own name to src/ (examples import it by name)
export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
