import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { TaskListItem } from "@ash/shared";
import { HandoffDialog } from "../../src/task-detail/HandoffDialog.tsx";
import { HandoffPeerKeyField } from "../../src/settings/HandoffPeerKeyField.tsx";
import "../../src/styles/global.css";

const scenario = new URLSearchParams(location.search).get("scenario") ?? "return";
const fingerprint = "a".repeat(64);
const url = "http://fixture-source:4317";
let showResult: (value: string) => void = () => {};
const target = { name: "测试来源机", url, peerFp: fingerprint, hasKey: false };
const nativeFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
  if (!path.startsWith("/api/")) return nativeFetch(input, init);
  const response = (status: number, body: unknown) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
  if (path === "/api/handoff/targets") return response(200, { targets: [] });
  if (path.endsWith("/handoff/return-target")) return response(200, { target });
  if (path.endsWith("/handoff/preflight")) return response(401, {
    error: "测试来源机需要账号 key", ash: true, code: "peer-key-required",
  });
  if (path === "/api/handoff/targets/key" && init?.method === "PUT") {
    const body = JSON.parse(String(init.body));
    if (body.allowUnlisted !== (scenario !== "settings")) return response(400, { error: "保存入口语义不匹配" });
    if (body.peerFp !== fingerprint || body.url !== url) {
      showResult("缺少任务机器指纹");
      return response(409, { error: "缺少任务机器指纹" });
    }
    if (body.peerKey === "wrong-key") return response(409, { error: "测试身份核对失败，key 未保存" });
    showResult(`${scenario} 已保存任务指纹 ${body.peerFp}`);
    return response(200, { targets: [] });
  }
  showResult(`未处理的 API ${path}`);
  return response(500, { error: `未处理的 API ${path}` });
}) as typeof window.fetch;

const task = {
  id: "fixture-key-task", projectId: "fixture-project", title: "移回来源机", status: "done", mode: "single",
  handoff: {
    direction: scenario === "return" ? "in" : "out",
    pending: scenario !== "return", peerFp: fingerprint, peerUrl: url,
    peerName: target.name, peerTaskId: "original", transferId: "transfer",
    ...(scenario === "pending-return" ? { returnTransferId: "return-transfer" } : {}),
  },
} as TaskListItem;

function Fixture() {
  const [result, setResult] = useState("");
  const [notice, setNotice] = useState("");
  showResult = setResult;
  return <>
    {scenario === "settings" ? <HandoffPeerKeyField
      url={url} peerFp={fingerprint} hasKey={false} mode="row" notify={setNotice} onSaved={() => {}}
    /> : <HandoffDialog task={task} notify={setNotice} onClose={() => {}} onTaskUpdate={() => {}} onOpenRemote={() => {}} />}
    <div style={{ position: "fixed", zIndex: 9999, bottom: 0, background: "white", color: "black" }}>
      <output aria-label="保存结果">{result}</output>
      <p role="status">{notice}</p>
    </div>
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
