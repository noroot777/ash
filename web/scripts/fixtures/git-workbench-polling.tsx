import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { GitWorkbenchState } from "@ash/shared/git-workbench";
import { useWorkbench } from "../../src/git-workbench/useWorkbench.ts";

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const state = (root: string, version: string): GitWorkbenchState => ({
  root,
  repo: root,
  status: {
    branch: {
      head: "main",
      oid: version,
      detached: false,
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
    },
    staged: [],
    unstaged: [],
    untracked: [],
    merge: [],
    truncated: false,
    operation: null,
  },
  version,
  refs: [],
  remotes: ["origin"],
  remoteDetails: [],
  worktrees: [],
  stashes: [],
  journal: [],
  backups: [],
  busy: false,
  readOnly: null,
});

type PendingRead = {
  root: string;
  resolve: (response: Response) => void;
};

const reads: PendingRead[] = [];
let actions = 0;
let actionRelease: (() => void) | null = null;
let holdAction = false;

const controls = {
  readCount: () => reads.length,
  actionCount: () => actions,
  releaseRead: (index: number, version: string) =>
    reads[index]?.resolve(reply(state(reads[index].root, version))),
  failRead: (index: number, message: string) =>
    reads[index]?.resolve(reply({ error: message }, 500)),
  holdAction: () => { holdAction = true; },
  releaseAction: () => actionRelease?.(),
};
(window as unknown as { __polling: typeof controls }).__polling = controls;

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href, location.origin);
  if (!/\/api\/projects\/fixture\/git\/workbench(?:\/actions)?(?:\?|$)/.test(url.href))
    return reply({ error: `unexpected ${url.pathname}` }, 404);
  if ((init?.method || "GET") === "POST") {
    actions += 1;
    if (holdAction) {
      holdAction = false;
      await new Promise<void>((resolve) => { actionRelease = resolve; });
    }
    return reply({
      ok: true,
      message: "write complete",
      entry: {
        id: String(actions),
        at: new Date().toISOString(),
        actor: "fixture",
        root: "/repo",
        action: "fetch",
        state: "succeeded",
        message: "write complete",
      },
    });
  }
  return new Promise<Response>((resolve) => {
    reads.push({ root: url.searchParams.get("root") || "/repo-a", resolve });
  });
};

function Fixture() {
  const [root, setRoot] = useState("/repo-a");
  const workbench = useWorkbench("fixture", root, undefined, () => {});
  return (
    <main>
      <p data-testid="root">{workbench.data?.root || "none"}</p>
      <p data-testid="version">{workbench.data?.version || "none"}</p>
      <p data-testid="loading">{String(workbench.loading)}</p>
      <p data-testid="busy">{String(workbench.busy)}</p>
      <p data-testid="error">{workbench.error || "none"}</p>
      <p data-testid="message">{workbench.message || "none"}</p>
      <button type="button" onClick={() => void workbench.refresh()}>refresh</button>
      <button
        type="button"
        disabled={workbench.blocked}
        onClick={() => void workbench.run({ kind: "fetch", remote: "origin" })}
      >
        write
      </button>
      <button type="button" onClick={() => setRoot((value) => value === "/repo-a" ? "/repo-b" : "/repo-a")}>
        switch root
      </button>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
