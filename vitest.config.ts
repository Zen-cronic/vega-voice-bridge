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
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // No test may reach AWS: every credential source is blanked, for the tests and every command they start.
    // The Polly and Bedrock tests run against stand-ins for the AWS CLI.
    env: {
      AWS_ACCESS_KEY_ID: '',
      AWS_SECRET_ACCESS_KEY: '',
      AWS_SESSION_TOKEN: '',
      AWS_PROFILE: '',
      AWS_DEFAULT_PROFILE: '',
      AWS_CONFIG_FILE: '/nonexistent/tv-voice-bridge-tests/aws-config',
      AWS_SHARED_CREDENTIALS_FILE: '/nonexistent/tv-voice-bridge-tests/aws-credentials',
      AWS_EC2_METADATA_DISABLED: 'true',
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '',
      AWS_CONTAINER_CREDENTIALS_FULL_URI: '',
      AWS_WEB_IDENTITY_TOKEN_FILE: '',
    },
  },
});
