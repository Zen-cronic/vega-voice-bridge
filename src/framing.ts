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

export class MessageAssembler {
  // The message in progress: its pieces so far, and where the scan stands at their end. Each piece is scanned
  // once, so reassembling a message costs time in proportion to its length, however many pieces it comes in.
  private parts: string[] = [];
  private partsLength = 0;
  private depth = 0;
  private inStr = false;
  private esc = false;
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
    return this.partsLength;
  }

  reset() {
    this.parts = [];
    this.partsLength = 0;
    this.depth = 0;
    this.inStr = false;
    this.esc = false;
  }

  /** Feed one received frame. Never throws. */
  push(chunk: string): AssembledBatch {
    const out: AssembledBatch = { messages: [], rejected: [] };
    if (this.partsLength && this.now() - this.pendingSince > this.staleMs) {
      out.rejected.push('stale partial message dropped');
      this.reset();
    }
    const hadPending = this.partsLength > 0;
    if (!hadPending) {
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
    const { objects, junk } = this.scan(chunk);
    if (hadPending) {
      // If the buffered piece never completes cleanly but this frame is a whole message by itself,
      // an earlier piece was lost: drop the buffer and keep the new message.
      const firstOk = objects.length > 0 && decodeMessage(objects[0]!).ok;
      if (!firstOk && decodeMessage(chunk).ok) {
        this.reset();
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
    if (this.partsLength > this.maxBytes) {
      out.rejected.push(`message larger than ${this.maxBytes} characters dropped`);
      this.reset();
    }
    return out;
  }

  /**
   * Scan one frame, carrying on with the message in progress. Returns the top-level JSON objects it completes and a
   * count of skipped junk; an object still open at the end of the frame is kept for the next one.
   */
  private scan(text: string): { objects: string[]; junk: number } {
    const objects: string[] = [];
    let junk = 0;
    let i = 0;
    const n = text.length;
    while (i < n) {
      let start = 0;
      if (!this.partsLength) {
        const c = text.charCodeAt(i);
        if (c === 32 || c === 9 || c === 10 || c === 13) {
          i++;
          continue;
        }
        if (c !== 123 /* { */) {
          junk++;
          const next = text.indexOf('{', i);
          if (next < 0) return { objects, junk };
          i = next;
          continue;
        }
        start = i;
        this.depth = 0;
        this.inStr = false;
        this.esc = false;
      }
      let { depth, inStr, esc } = this;
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
      if (j >= n) {
        // The message continues in a later frame.
        this.depth = depth;
        this.inStr = inStr;
        this.esc = esc;
        const piece = start ? text.slice(start) : text;
        if (piece.length) {
          this.parts.push(piece);
          this.partsLength += piece.length;
          this.pendingSince = this.now();
        }
        return { objects, junk };
      }
      const tail = text.slice(start, j + 1);
      objects.push(this.partsLength ? this.parts.join('') + tail : tail);
      this.reset();
      i = j + 1;
    }
    return { objects, junk };
  }
}
