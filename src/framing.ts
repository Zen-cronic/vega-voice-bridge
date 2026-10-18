/**
 * Message reassembly for clients whose WebSocket may deliver one JSON message in several `onmessage` events,
 * or several messages in one (seen on React Native runtimes, including Vega). The wire format does not change:
 * senders still send one JSON object per text frame. Receivers that use this tolerate splits and coalescing.
 */
import { decodeMessage, type BridgeMessage } from './protocol.js';

export interface AssemblerOptions {
  /** Largest message to buffer while waiting for the rest of it. Default 1 MiB (characters). */
  maxBytes?: number;
  /** Drop a partial message that has waited this long for its next piece. Default 5 s. */
  staleMs?: number;
  now?: () => number;
}

export interface AssembledBatch {
  messages: BridgeMessage[];
  /** One entry per piece of input that was dropped, with the reason. */
  rejected: string[];
}

/** Find complete top-level JSON objects in `text`. Returns them, a count of skipped junk, and the incomplete tail. */
function scan(text: string): { objects: string[]; junk: number; rest: string } {
  const objects: string[] = [];
  let junk = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      i++;
      continue;
    }
    if (c !== 123 /* { */) {
      junk++;
      const next = text.indexOf('{', i);
      if (next < 0) return { objects, junk, rest: '' };
      i = next;
      continue;
    }
    let depth = 0;
    let inStr = false;
    let esc = false;
    let j = i;
    for (; j < n; j++) {
      const ch = text.charCodeAt(j);
      if (inStr) {
        if (esc) esc = false;
        else if (ch === 92 /* \ */) esc = true;
        else if (ch === 34 /* " */) inStr = false;
        continue;
      }
      if (ch === 34) inStr = true;
      else if (ch === 123 || ch === 91) depth++;
      else if (ch === 125 || ch === 93) {
        depth--;
        if (depth === 0) break;
      }
    }
    if (j >= n) return { objects, junk, rest: text.slice(i) };
    objects.push(text.slice(i, j + 1));
    i = j + 1;
  }
  return { objects, junk, rest: '' };
}

export class MessageAssembler {
  private pending = '';
  private pendingSince = 0;
  private readonly maxBytes: number;
  private readonly staleMs: number;
  private readonly now: () => number;

  constructor(opts: AssemblerOptions = {}) {
    this.maxBytes = opts.maxBytes ?? 1024 * 1024;
    this.staleMs = opts.staleMs ?? 5000;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Characters buffered while waiting for the rest of a message. */
  get pendingLength(): number {
    return this.pending.length;
  }

  reset() {
    this.pending = '';
  }

  /** Feed one received frame. Never throws. */
  push(chunk: string): AssembledBatch {
    const out: AssembledBatch = { messages: [], rejected: [] };
    if (this.pending && this.now() - this.pendingSince > this.staleMs) {
      out.rejected.push('stale partial message dropped');
      this.pending = '';
    }
    if (!this.pending) {
      // Fast path: the normal case, one whole message per frame.
      const r = decodeMessage(chunk);
      if (r.ok) {
        out.messages.push(r.msg);
        return out;
      }
      if (r.reason === 'shape') {
        out.rejected.push(r.error);
        return out;
      }
    }
    const hadPending = this.pending.length > 0;
    const { objects, junk, rest } = scan(this.pending + chunk);
    if (hadPending) {
      // If the buffered piece never completes cleanly but this frame is a whole message by itself,
      // an earlier piece was lost: drop the buffer and keep the new message.
      const firstOk = objects.length > 0 && decodeMessage(objects[0]!).ok;
      if (!firstOk && decodeMessage(chunk).ok) {
        this.pending = '';
        out.rejected.push('incomplete message dropped');
        const again = this.push(chunk);
        out.messages.push(...again.messages);
        out.rejected.push(...again.rejected);
        return out;
      }
    }
    for (let k = 0; k < junk; k++) out.rejected.push('text outside a JSON object');
    for (const o of objects) {
      const r = decodeMessage(o);
      if (r.ok) out.messages.push(r.msg);
      else out.rejected.push(r.error);
    }
    if (rest.length > this.maxBytes) {
      out.rejected.push(`message larger than ${this.maxBytes} characters dropped`);
      this.pending = '';
    } else {
      if (rest && rest !== this.pending) this.pendingSince = this.now();
      this.pending = rest;
    }
    return out;
  }
}
