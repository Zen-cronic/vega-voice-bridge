/**
 * Minimal React Native for Vega screen for vega-voice-bridge: pair, show what the phone heard and the answer,
 * and say the answer out loud. The full, built and measured version is examples/vega-voice-loop.
 *
 * Drop it into a `vega project generate` app that has this package and @amazon-devices/react-native-w3cmedia
 * installed (and the media services in manifest.toml, as in examples/vega-voice-loop/vega/manifest.toml).
 *
 * Vega specifics this shows:
 *  - Vega has no app-level speech-to-text API, so the phone listens and the TV is a `screen` peer.
 *  - React Native's global WebSocket works; use a reverse port forward on the VVD (see README, "Vega notes").
 *  - `createVegaSayPlayer` plays https in URL mode, or fragmented MP4/AAC from a plain-http hub through MSE,
 *    and reports every playback state, so the hook can queue lines and the phone's echo guard knows when the
 *    TV is audible.
 */
import React, {useEffect, useMemo} from 'react';
import {Text, View} from 'react-native';
import {PairingQr, useVoiceBridge} from 'vega-voice-bridge/react';
import {createVegaSayPlayer} from 'vega-voice-bridge/vega';

// The voice-loop hub (node examples/vega-voice-loop/hub.mjs): it serves the fragmented MP4 clips the player needs.
// The web-TV examples on 8800 send text only, so the TV would show captions and report "no audioUrl".
const HUB = '127.0.0.1:8790';

export function App() {
  const player = useMemo(() => createVegaSayPlayer({baseUrl: `http://${HUB}`}), []);
  useEffect(() => {
    void player.warm();
    return () => void player.dispose();
  }, [player]);
  // Acks each intent after the frame that shows it, and queues say lines through the player.
  const tv = useVoiceBridge({url: `ws://${HUB}/ws`, name: 'tv', player});
  const answer = (tv.intent?.payload as {reply?: string} | undefined)?.reply;

  return (
    <View style={{flex: 1, flexDirection: 'row', padding: 40, gap: 30, backgroundColor: '#111'}}>
      <View style={{gap: 10}}>
        {tv.joinUrl ? <PairingQr value={tv.joinUrl} size={200} /> : null}
        <Text style={{color: '#fff', fontSize: 32}}>{tv.code ?? '····'}</Text>
        <Text style={{color: '#aaa', fontSize: 14}}>{tv.status}</Text>
      </View>
      <View style={{flex: 1, gap: 12}}>
        <Text style={{color: '#ddd', fontSize: 22}}>{tv.partial ?? tv.final?.text ?? 'Say something into the phone.'}</Text>
        <Text style={{color: '#fff', fontSize: 28, fontWeight: '700'}}>{answer ?? ''}</Text>
        <Text style={{color: '#8cf', fontSize: 14}}>{tv.saying ? `${tv.saying.state}: ${tv.saying.line.text}` : ''}</Text>
      </View>
    </View>
  );
}
