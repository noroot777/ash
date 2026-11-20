import { handedOver } from "./launch-handover.js";
import { probeOwnedPorts } from "./service-ports.js";
import { sessionRunning } from "./terminal-session-view.js";
import type { TerminalCreation, TerminalSession } from "./terminal-session-facts.js";
import type { ShutdownResource } from "./shutdown-resources.js";

export async function terminalShutdownResources(
  sessions: Iterable<TerminalSession>, creations: Iterable<TerminalCreation>,
): Promise<ShutdownResource[]> {
  const resources: ShutdownResource[] = [...creations].map((creation, index) => ({
    kind: "terminal-start", id: `${creation.projectId}:${index}`, label: "正在创建终端", projectId: creation.projectId,
  }));
  for (const session of sessions) {
    if (handedOver(session)) continue;
    let active = sessionRunning(session);
    if (!active && session.commandId !== null && session.launchPorts.size > 0) {
      const probe = await probeOwnedPorts(session.launchPorts, session.launchToken);
      active = probe.state === "ours" || probe.state === "unknown";
    }
    if (active) resources.push({
      kind: "terminal", id: session.id, label: session.name, projectId: session.projectId,
      pid: session.process.pid, ports: [...session.launchPorts],
    });
  }
  return resources;
}
