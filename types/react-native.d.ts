// The one React Native export `./react` uses, so this package type-checks without installing react-native.
// An app's own react-native (or react-native-web) types take over in its build.
declare module 'react-native' {
  import type { ComponentType } from 'react';
  export const View: ComponentType<Record<string, unknown>>;
}
