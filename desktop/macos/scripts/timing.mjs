import { performance } from "node:perf_hooks";

export function timed(label, operation, say = console.log) {
  const started = performance.now();
  let status = "failed";
  try {
    const result = operation();
    status = "ok";
    return result;
  } finally {
    say(`[mac-timing] ${label}: ${((performance.now() - started) / 1000).toFixed(3)}s status=${status}`);
  }
}
