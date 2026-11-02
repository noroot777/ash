import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { PreviewServiceState } from "@ash/shared/preview";
import { PillTabs } from "../../src/components/ui.tsx";
import { InspectorRail } from "../../src/inspector/InspectorRail.tsx";
import { PreviewServiceTabs } from "../../src/free-workflow/PreviewServiceTabs.tsx";
import { ComposerLaunchControl, type LaunchMode } from "../../src/composer/ComposerLaunchControl.tsx";
import { ProviderForm } from "../../src/settings/ProvidersSection.tsx";
import { useRovingChoice } from "../../src/lib/useRovingChoice.ts";
import "../../src/styles/global.css";

// 按钮当单选 / 分页用的那一堆组,**键盘的那一半**(src/lib/useRovingChoice.ts)的台子。
//
// 摆的全是真货,而且特意挑了结构差得最远的几处 —— 这个契约每次失守都不是算错了下一颗
// 是谁,而是某一处的结构跟别处不一样,于是那一处的键盘静悄悄地不动:
//   · PillTabs:按钮就是组容器的亲儿子(最朴素那一种);
//   · 协议二选一:`role=radio` 那一档,而且新建时**一个都没选中**;
//   · Inspector 图标条:竖排,按钮由子组件渲染,组外还坐着一颗「+」;
//   · 服务日志条:组的 `role` 在**另一个组件**(可横向滚的那层)上,「全部」那一档在
//     数据上还是 `undefined`;
//   · 启动方式:整组在浮层(portal)里,而且「创建并排队」会被禁用;
//   · 最后那个组是直接拿钩子搭的:组里混着一颗**不属于这一组取值**的按钮(真实页面里
//     是新建任务那条 tab 条末尾的「开聊」),它不该被方向键接管。
const SERVICES: PreviewServiceState[] = [
  { id: "svc-web", name: "web", command: "npm run dev", status: "ready", url: "http://127.0.0.1:5173", port: 5173, lentPort: 5173 },
  { id: "svc-api", name: "api", command: "npm run api", status: "starting", url: null, port: null, lentPort: 4000 },
  { id: "svc-worker", name: "worker", command: "npm run worker", status: "failed", url: null, port: null, lentPort: null },
];

const RAIL_ITEMS = ["概览", "队列", "附件", "监控"].map((title, index) => ({
  id: `panel-${index}`,
  title,
  icon: <span aria-hidden="true">{title.slice(0, 1)}</span>,
}));

/** 组里混进一颗外来按钮的那一种,直接拿钩子搭 —— 真实页面在 ComposerFields 的任务模式条。 */
function MixedTabs({ onPick }: { onPick: (value: string) => void }) {
  const values = ["single", "team", "duet"];
  const [value, setValue] = useState("single");
  const group = useRovingChoice(values, value, (picked) => { setValue(picked); onPick(picked); }, "tab");
  return (
    <div className="ui-tabs" {...group.groupProps} aria-label="任务模式">
      {values.map((item) => (
        <button key={item} type="button" data-testid={`mode-${item}`} {...group.itemProps(item)}
          onClick={() => { setValue(item); onPick(item); }}>{item}</button>
      ))}
      {/* 这一颗是动作不是取值:它没有 data-choice-value,方向键不该走到它身上。 */}
      <button type="button" role="tab" aria-selected={false} data-testid="mode-chat"
        onClick={() => onPick("chat")}>开聊</button>
    </div>
  );
}

function Fixture() {
  const [pill, setPill] = useState<"free" | "preset">("free");
  const [railId, setRailId] = useState<string | null>("panel-0");
  const [serviceId, setServiceId] = useState<string | undefined>(undefined);
  const [launch, setLaunch] = useState<LaunchMode>("run");
  const [log, setLog] = useState<string[]>([]);
  const note = (entry: string) => setLog((prev) => [...prev, entry]);

  return <main>
    <p data-testid="log">{log.join(",")}</p>
    <p data-testid="pill">{pill}</p>
    <p data-testid="rail">{railId ?? "-"}</p>
    <p data-testid="service">{serviceId ?? "全部"}</p>
    <p data-testid="launch">{launch}</p>

    <section>
      <PillTabs label="工作方式" value={pill}
        items={[{ value: "free", label: "自由工作流" }, { value: "preset", label: "起手式" }]}
        onChange={(value) => { setPill(value); note(`pill:${value}`); }} />
    </section>

    <section className="inspector-host" style={{ height: 260 }}>
      <InspectorRail items={RAIL_ITEMS} allItems={RAIL_ITEMS} activeId={railId}
        tabIdFor={(id) => `tab-${id}`} contentIdFor={(id) => `content-${id}`}
        onSelect={(id) => { setRailId(id); note(`rail:${id}`); }} onOpen={(id) => note(`open:${id}`)} />
    </section>

    <section>
      <PreviewServiceTabs services={SERVICES} serviceId={serviceId} panelId="preview-log"
        onSelect={(id) => { setServiceId(id); note(`service:${id ?? "全部"}`); }} />
    </section>

    <section>
      <ComposerLaunchControl mode={launch} at="" cron="" busy={false} canSubmit
        onModeChange={(mode) => { setLaunch(mode); note(`launch:${mode}`); }}
        onAtChange={() => {}} onCronChange={() => {}} onSubmit={() => {}}
        attachmentTool={null} executorTools={null}
        queueUnavailable="团队任务不支持排队" />
    </section>

    <section className="settings-section">
      <ProviderForm onCancel={() => {}} onSaved={async () => {}} notify={note} />
    </section>

    <section>
      <MixedTabs onPick={(value) => note(`mode:${value}`)} />
    </section>
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>);
