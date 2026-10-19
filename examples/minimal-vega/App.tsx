/**
 * Minimal React Native for Vega screen for tv-voice-bridge.
 *
 * ILLUSTRATIVE: this file is not built or type-checked in this repo (it needs a Vega project's dependencies,
 * such as react-native and @amazon-devices/react-native-w3cmedia). Drop it into a `vega project generate` app
 * that has this package installed.
 *
 * Vega specifics this shows:
 *  - Vega has no app-level speech-to-text API, so the phone listens and the TV is a `screen` peer.
 *  - React Native's global WebSocket works; use a reverse port forward on the VVD (see README, "Vega notes").
 *    The client reconnects on its own, detects a dead link even if onclose never fires, and reassembles
 *    messages split across frames.
 *  - The W3C media player plays only publicly trusted https URLs, so `screen.say` audio must be https
 *    (e.g. an S3 presigned URL). Otherwise show the caption for `durationMs` and report `no-audio`.
 */
import React, {useEffect, useRef, useState} from 'react';
import {Text, View} from 'react-native';
import {AudioPlayer} from '@amazon-devices/react-native-w3cmedia';
import {BridgeClient} from 'tv-voice-bridge';

const HUB = 'ws://127.0.0.1:8800/ws';

export function App() {
  const [code, setCode] = useState('····');
  const [status, setStatus] = useState('connecting…');
  const [heard, setHeard] = useState('Say something into the phone.');
  const [caption, setCaption] = useState('');
  const player = useRef<InstanceType<typeof AudioPlayer> | null>(null);
  const captionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const tv = new BridgeClient({url: HUB, role: 'screen'});
    // Only the newest line's timer may clear the caption.
    const showCaption = (text: string, ms: number) => {
      if (captionTimer.current) clearTimeout(captionTimer.current);
      setCaption(text);
      captionTimer.current = setTimeout(() => setCaption(''), ms);
    };
    tv.on('welcome', (w) => setCode(w.code));
    tv.on('status', (s) => setStatus(s === 'reconnecting' ? 'Hub offline, retrying…' : s));
    tv.on('intent', (m) => {
      const receivedAt = performance.timeOrigin + performance.now();
      setHeard(String((m.payload as {text?: string}).text ?? ''));
      requestAnimationFrame(() => tv.ack(m, {receivedAt}));
    });
    const off = tv.onSay(async (line) => {
      if (!/^https:/i.test(line.audioUrl)) {
        showCaption(line.text, line.durationMs);
        tv.reportSay({id: line.id, state: 'no-audio'});
        return;
      }
      showCaption(line.text, line.durationMs + 1000);
      try {
        tv.reportSay({id: line.id, state: 'loading'});
        player.current ??= new AudioPlayer();
        await player.current.initialize();
        player.current.src = line.audioUrl;
        await player.current.play();
        tv.reportSay({id: line.id, state: 'playing'});
      } catch (e) {
        tv.reportSay({id: line.id, state: 'error', detail: String(e)});
      }
    });
    tv.connect().catch(() => undefined); // keeps retrying in the background
    return () => {
      off();
      tv.close();
      if (captionTimer.current) clearTimeout(captionTimer.current);
    };
  }, []);

  return (
    <View style={{flex: 1, backgroundColor: '#0b0d11', padding: 96}}>
      <Text style={{color: '#9aa4b2', fontSize: 28}}>Pair with code · {status}</Text>
      <Text style={{color: '#f4f6f8', fontSize: 120, fontWeight: '800', letterSpacing: 24}}>{code}</Text>
      <Text style={{color: '#f4f6f8', fontSize: 56, fontWeight: '700', marginTop: 40}}>{heard}</Text>
      <Text style={{color: '#ffcf33', fontSize: 36, marginTop: 40}}>{caption}</Text>
    </View>
  );
}
