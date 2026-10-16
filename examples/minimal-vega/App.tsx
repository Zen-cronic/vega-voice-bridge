/**
 * Minimal React Native for Vega screen for tv-voice-bridge.
 *
 * ILLUSTRATIVE: this file is not built or type-checked in this repo (it needs a Vega project's dependencies,
 * such as react-native and @amazon-devices/react-native-w3cmedia). Drop it into a `vega project generate` app
 * that has this package installed.
 *
 * Vega specifics this shows:
 *  - Vega has no third-party microphone API, so the phone is the mic; the TV is a `screen` peer.
 *  - React Native's global WebSocket works; use a reverse port forward on the VVD (see README, "Vega notes").
 *  - The W3C media player plays only publicly trusted https URLs, so `screen.say` audio must be https
 *    (e.g. an S3 presigned URL). Otherwise show the caption for `durationMs`.
 */
import React, {useEffect, useRef, useState} from 'react';
import {Text, View} from 'react-native';
import {AudioPlayer} from '@amazon-devices/react-native-w3cmedia';
import {BridgeClient} from '@rackboard/tv-voice-bridge';

const HUB = 'ws://127.0.0.1:8800/ws';

export function App() {
  const [code, setCode] = useState('····');
  const [heard, setHeard] = useState('Say something into the phone.');
  const [caption, setCaption] = useState('');
  const player = useRef<InstanceType<typeof AudioPlayer> | null>(null);

  useEffect(() => {
    const tv = new BridgeClient({url: HUB, role: 'screen'});
    tv.on('welcome', (w) => setCode(w.code));
    tv.on('intent', (m) => {
      const receivedAt = performance.timeOrigin + performance.now();
      setHeard(String((m.payload as {text?: string}).text ?? ''));
      requestAnimationFrame(() => tv.ack(m, {receivedAt}));
    });
    const off = tv.onSay(async (line) => {
      setCaption(line.text);
      if (!/^https:/i.test(line.audioUrl)) return void setTimeout(() => setCaption(''), line.durationMs); // caption only
      try {
        player.current ??= new AudioPlayer();
        await player.current.initialize();
        player.current.src = line.audioUrl;
        await player.current.play();
        tv.reportSay({id: line.id, state: 'playing'});
      } catch (e) {
        tv.reportSay({id: line.id, state: 'error', detail: String(e)});
      }
    });
    tv.connect().catch(() => undefined);
    return () => {
      off();
      tv.close();
    };
  }, []);

  return (
    <View style={{flex: 1, backgroundColor: '#0b0d11', padding: 96}}>
      <Text style={{color: '#9aa4b2', fontSize: 28}}>Pair with code</Text>
      <Text style={{color: '#f4f6f8', fontSize: 120, fontWeight: '800', letterSpacing: 24}}>{code}</Text>
      <Text style={{color: '#f4f6f8', fontSize: 56, fontWeight: '700', marginTop: 40}}>{heard}</Text>
      <Text style={{color: '#ffcf33', fontSize: 36, marginTop: 40}}>{caption}</Text>
    </View>
  );
}
