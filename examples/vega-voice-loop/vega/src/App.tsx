// The TV half of the voice loop on Vega: the pairing QR, the phone's words as they arrive, the answer, and the
// answer said out loud, with the hub's measurements of each loop.
import React, {useEffect, useMemo, useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {PairingQr, useVoiceBridge} from 'tv-voice-bridge/react';
import {createVegaSayPlayer} from 'tv-voice-bridge/vega';
import hubDefault from './hub.json';

type HubConfig = {hostport: string; httpUrlMode?: boolean};
// Where the hub is: src/hub.local.json when `npm run hub` wrote one (git ignores it, so a LAN address never lands in
// a tracked file), else the tracked src/hub.json, 127.0.0.1:8790 through a reverse port forward. Metro bundles a
// require inside a try as optional, so a checkout without the local file builds, and requiring it then throws.
const hub: HubConfig = (() => {
  try {
    const local = require('./hub.local.json') as Partial<HubConfig> | undefined;
    if (typeof local?.hostport === 'string') return local as HubConfig;
  } catch {
    // no local file
  }
  return hubDefault;
})();

type Row = {sayId?: string; said: string; shownMs: number | null; sayToPlayingMs: number | null; heardMs: number | null};

export function App() {
  // "httpUrlMode": true (npm run hub -- <host:port> --http-url-mode) plays http clips in URL mode instead of MSE: the
  // stick run's check of whether the OS now allows cleartext media (scripts/stick-run.md). Leave it off otherwise.
  const player = useMemo(() => createVegaSayPlayer({baseUrl: `http://${hub.hostport}`, httpUrlMode: hub.httpUrlMode === true}), []);
  useEffect(() => {
    void player.warm(); // the first reply is not delayed by the media player's start-up
    return () => void player.dispose();
  }, [player]);
  const tv = useVoiceBridge({url: `ws://${hub.hostport}/ws`, name: 'tv', player});
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(
    () => tv.client?.on('app', (m) => m.topic === 'loop.metrics' && setRows((r) => [m.payload as Row, ...r].slice(0, 5))),
    [tv.client],
  );

  const answer = (tv.intent?.payload as {reply?: string} | undefined)?.reply;
  // The hub sends a row when the reply has finished playing; until then the current utterance shows as pending.
  const heard = tv.final;
  const pending: Row | null =
    heard && rows[0]?.sayId !== `say_${heard.utteranceId}` ? {said: heard.text, shownMs: null, sayToPlayingMs: null, heardMs: null} : null;
  const shown = pending ? [pending, ...rows].slice(0, 5) : rows;
  const audio = tv.saying?.state ?? 'idle';
  const ms = (n: number | null | undefined) => (n == null ? '–' : `${Math.round(n)} ms`);
  return (
    <View style={s.root}>
      <View style={s.left}>
        <Text style={s.brand}>VOICE LOOP</Text>
        {tv.joinUrl ? <PairingQr value={tv.joinUrl} size={190} /> : null}
        <Text style={s.code}>{tv.code ?? '····'}</Text>
        <Text style={s.dim}>{tv.status === 'paired' ? `paired · ${tv.mics} phone${tv.mics === 1 ? '' : 's'}` : tv.status}</Text>
      </View>
      <View style={s.right}>
        <Text style={s.kicker}>YOU SAID</Text>
        <Text style={s.heard} numberOfLines={2}>
          {tv.partial ? `${tv.partial}…` : tv.final?.text ?? 'Talk into your phone.'}
        </Text>
        <Text style={s.kicker}>THE TV ANSWERS</Text>
        <Text style={s.answer} numberOfLines={3}>{answer ?? '–'}</Text>
        <Text style={[s.chip, audio === 'playing' && s.chipOn]}>{`audio: ${audio}`}</Text>
        <Text style={s.kicker}>MEASURED (HUB CLOCK)</Text>
        <View style={s.tr}>
          {['said', 'speech end → shown', 'say → playing', 'speech end → heard'].map((h) => (
            <Text key={h} style={[s.td, s.th]}>{h}</Text>
          ))}
        </View>
        {shown.map((r, i) => (
          <View key={i} style={s.tr}>
            <Text style={s.td} numberOfLines={1}>{r.said}</Text>
            <Text style={s.td}>{r === pending ? '…' : ms(r.shownMs)}</Text>
            <Text style={s.td}>{r === pending ? '…' : ms(r.sayToPlayingMs)}</Text>
            <Text style={s.td}>{r === pending ? '…' : ms(r.heardMs)}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// Vega lays out in density-independent units, about half the 1080p pixel size.
const s = StyleSheet.create({
  root: {flex: 1, flexDirection: 'row', backgroundColor: '#0b1530', padding: 40},
  left: {width: 260, gap: 12},
  right: {flex: 1, paddingLeft: 30, gap: 7},
  brand: {color: '#5eead4', fontSize: 14, fontWeight: '700', letterSpacing: 3},
  code: {color: '#fff', fontSize: 36, fontWeight: '800', letterSpacing: 6},
  dim: {color: '#94a3b8', fontSize: 13},
  kicker: {color: '#94a3b8', fontSize: 11, fontWeight: '700', letterSpacing: 2, marginTop: 9},
  heard: {color: '#e2e8f0', fontSize: 22},
  answer: {color: '#fff', fontSize: 26, fontWeight: '700'},
  chip: {color: '#cbd5e1', fontSize: 12, alignSelf: 'flex-start', borderWidth: 1, borderColor: '#334155', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2},
  chipOn: {color: '#0b1530', backgroundColor: '#5eead4', borderColor: '#5eead4'},
  tr: {flexDirection: 'row'},
  td: {flex: 1, color: '#e2e8f0', fontSize: 12, paddingVertical: 2},
  th: {color: '#94a3b8', fontWeight: '700'},
});
