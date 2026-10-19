const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

// The default config keeps Vega's platform resolver (react-native -> @amazon-devices/react-native-kepler).
module.exports = mergeConfig(getDefaultConfig(__dirname), {});
