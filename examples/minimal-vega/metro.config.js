// OPTIONAL. Only needed to bundle vega-voice-bridge from its TypeScript source (a git submodule or a monorepo folder).
// Installed from npm or a packed tarball, Metro resolves the built dist/ through the package's exports, and the
// default Vega Metro config works unchanged.
//
// The package's source uses TS-ESM imports ("./protocol.js"); Metro needs them mapped to .ts. A custom resolveRequest
// REPLACES Vega's own platform resolver, so the react-native -> @amazon-devices/react-native-kepler mapping is
// re-applied first (without it the bundle silently ships core React Native and the app aborts at launch).
const path = require('path');
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

const bridgeSrc = path.resolve(__dirname, '../vega-voice-bridge/src'); // adjust to where the package lives
const KEPLER_RN = '@amazon-devices/react-native-kepler';

module.exports = mergeConfig(getDefaultConfig(__dirname), {
  watchFolders: [bridgeSrc],
  resolver: {
    nodeModulesPaths: [path.join(__dirname, 'node_modules')],
    resolveRequest: (context, moduleName, platform) => {
      if (platform === 'kepler') {
        if (moduleName === 'react-native') moduleName = KEPLER_RN;
        else if (moduleName.startsWith('react-native/')) moduleName = `${KEPLER_RN}/${moduleName.slice('react-native/'.length)}`;
      }
      if (context.originModulePath.startsWith(bridgeSrc) && moduleName.startsWith('.') && moduleName.endsWith('.js'))
        return context.resolveRequest(context, moduleName.slice(0, -3), platform);
      return context.resolveRequest(context, moduleName, platform);
    },
  },
});
