import { EventEmitter } from "node:events";
import type { ServerEvent } from "@harness/shared";

// Single in-process pub/sub. The orchestrator publishes; SSE handlers subscribe.
// Lives in the long-running server process (DESIGN.md §11: orchestrator singleton).
class Bus extends EventEmitter {
  publish(ev: ServerEvent) {
    this.emit("event", ev);
  }
  subscribe(fn: (ev: ServerEvent) => void) {
    this.on("event", fn);
    return () => this.off("event", fn);
  }
}

export const bus = new Bus();
bus.setMaxListeners(0);
