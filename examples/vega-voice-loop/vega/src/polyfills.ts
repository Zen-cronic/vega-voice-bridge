/**
 * The shared bridge client stamps hops with `performance.timeOrigin + performance.now()`.
 * Browsers and Node have timeOrigin; check the RN/Hermes runtime and fill it in if missing,
 * so hop timestamps stay in epoch milliseconds like the other clients.
 */
const perf = (globalThis as unknown as {performance?: {now(): number; timeOrigin?: number}}).performance;
export const hadTimeOrigin = !!perf && typeof perf.timeOrigin === 'number' && perf.timeOrigin > 1e12;

if (perf && !hadTimeOrigin) {
  const origin = Date.now() - perf.now();
  try {
    Object.defineProperty(perf, 'timeOrigin', {value: origin, configurable: true});
  } catch {
    (perf as {timeOrigin?: number}).timeOrigin = origin;
  }
}
