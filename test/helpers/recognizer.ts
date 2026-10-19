// A recognizer the tests drive in place of Web Speech (shared by the phone and React tests).
import type { RecognitionEventLike, RecognizerLike } from '../../src/phone.js';

/** A recognizer the test drives: `hear()` updates the open result, `final()` closes it, `end()` ends the session. */
export class ScriptedRecognizer implements RecognizerLike {
  static all: ScriptedRecognizer[] = [];
  lang = '';
  continuous = false;
  interimResults = false;
  running = false;
  aborted = false;
  onstart: ((ev: unknown) => void) | null = null;
  onresult: ((ev: RecognitionEventLike) => void) | null = null;
  onerror: ((ev: { error: string; message?: string }) => void) | null = null;
  onend: ((ev: unknown) => void) | null = null;
  onspeechstart: ((ev: unknown) => void) | null = null;
  onspeechend: ((ev: unknown) => void) | null = null;
  private results: Array<{ isFinal: boolean; length: number; 0: { transcript: string } }> = [];
  constructor() {
    ScriptedRecognizer.all.push(this);
  }
  static get last(): ScriptedRecognizer {
    return ScriptedRecognizer.all[ScriptedRecognizer.all.length - 1]!;
  }
  start() {
    this.running = true;
    this.onstart?.({});
  }
  stop() {
    this.end();
  }
  abort() {
    this.aborted = true;
    this.onerror?.({ error: 'aborted' });
    this.end();
  }
  end() {
    if (!this.running) return;
    this.running = false;
    this.onend?.({});
  }
  error(code: string) {
    this.onerror?.({ error: code });
  }
  private push(text: string, isFinal: boolean) {
    let i = this.results.length - 1;
    if (i < 0 || this.results[i]!.isFinal) i = this.results.push({ isFinal, length: 1, 0: { transcript: text } }) - 1;
    else this.results[i] = { isFinal, length: 1, 0: { transcript: text } };
    this.onresult?.({ resultIndex: i, results: this.results });
  }
  hear(text: string) {
    this.push(text, false);
  }
  final(text: string) {
    this.push(text, true);
  }
  /** Deliver the results again from `index` on, as some recognizers do (iOS Safari in continuous mode). */
  redeliver(index = 0) {
    this.onresult?.({ resultIndex: index, results: this.results });
  }
}
