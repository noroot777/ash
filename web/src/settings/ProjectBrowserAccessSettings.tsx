import { useEffect, useState } from "react";
import type { ProjectView } from "@ash/shared";
import { MAX_BROWSER_CDP_DOMAINS, browserCdpHostOf, normalizeBrowserCdpDomains } from "@ash/shared/project";
import { Button } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import "./project-browser-access.css";

// 项目「浏览器登录态」授权节。
//
// 这块存在的理由只有一个:**无人值守**。抓登录后才可见的内容(推特、微博一类)时,干净的
// 临时 profile 没有 cookie,撞上登录墙只会产出一份假的「失败」;而让 agent 每次停下来问,
// 定时任务就跑不成。所以授权必须能一次设好、长期有效 —— 这正是这个输入框。
//
// 填的是**域名**而不是一颗总开关:总开关一开就是对所有站点放行,而用户真正想授权的通常
// 只有一两个站点。名单同时承担「开/关」(空 = 不授权)和「范围」两件事,不会出现「开关开着
// 但名单是空的」这种没有归宿的状态。
export function ProjectBrowserAccessSettings({ project, onUpdated, notify, canManage }: {
  project: ProjectView;
  onUpdated: (next: ProjectView) => void;
  notify: (message: string) => void;
  canManage: boolean;
}) {
  const saved = project.browserCdpDomains ?? [];
  const [text, setText] = useState(saved.join("\n"));
  const [busy, setBusy] = useState(false);
  // 切项目时把草稿换成那个项目的值 —— 否则会把上一个项目的名单保存到这个项目头上。
  useEffect(() => { setText((project.browserCdpDomains ?? []).join("\n")); }, [project.id]);

  // 所见即所得:用户填的是一行文本,存进去的是归一化之后的裸主机名。两者不一致时
  // (粘了整条 URL、写了 localhost)必须当场看得见,不能等保存完才发现少了一条。
  const parsed = normalizeBrowserCdpDomains(text);
  const dirty = parsed.join("\n") !== saved.join("\n");
  // 「认不出形状」和「重复/超上限」要分开数:同一个域名写两遍也会让 parsed 变短,
  // 一股脑算成「认不出」等于告诉用户他打错了字,而他并没有。
  const tokens = text.split(/[\s,，、]+/).filter(Boolean);
  const invalid = tokens.filter((token) => !browserCdpHostOf(token)).length;
  const deduped = tokens.length - invalid - parsed.length;

  const save = async () => {
    setBusy(true);
    try {
      const next = await api.updateProject(project.id, { browserCdpDomains: parsed });
      onUpdated(next);
      setText((next.browserCdpDomains ?? []).join("\n"));
      // toast 是一条窄浮层,不能把整份名单原样塞进去:合法域名可长到 253 字符,
      // 一条就能把它撑出屏幕。太长就只报个数 —— 完整名单卡片里就在眼前。
      const list = next.browserCdpDomains ?? [];
      const shown = list.join("、");
      notify(list.length
        ? `已授权：本项目的任务可以用你登录的 Chrome 只读${shown.length > 48 ? ` ${list.length} 个站点（名单见设置卡片）` : ` ${shown}`}`
        : "已收回浏览器登录态授权");
    } catch (error) {
      notify(error instanceof Error ? error.message : "浏览器授权保存失败");
    } finally { setBusy(false); }
  };

  return <section className="settings-section"><h2>浏览器登录态</h2><div className="settings-card">
    <div className="browser-access__intro">
      <b>允许用我登录的 Chrome 只读这些站点</b>
      <small>
        一行一个域名（<code>x.com</code>），自动包含子域。留空 = 不授权，这是默认。
        最多 {MAX_BROWSER_CDP_DOMAINS} 个。
      </small>
      <small>
        设了之后，本项目的任务遇到「必须登录才看得到」的内容时可以直接用你的登录态，
        不必每次在任务里点名 —— 定时抓取这类无人值守的活靠的就是它。
      </small>
      <small>
        <b>范围默认只读</b>：名单内也只允许新建后台标签读数据，禁止接管或导航你正在用的标签、
        禁止激活窗口，禁止一切写操作（发布、点赞、关注、改设置、发消息）。名单外的站点仍会停下来问你。
      </small>
      <small>
        这组限制是默认态而不是硬禁令：要让任务写（发帖、点赞、改设置）或接管你的标签，
        在任务里明确说出来就行 —— 放开的只有你点名的那一项，没点名的照旧禁止。
      </small>
    </div>
    <label className="browser-access__field">
      <textarea
        rows={4}
        spellCheck={false}
        placeholder={"x.com\nweibo.com"}
        value={text}
        disabled={busy || !canManage}
        onChange={(event) => setText(event.target.value)}
      />
      {dirty && parsed.length > 0 && <small>将保存为：{parsed.join("、")}</small>}
      {invalid > 0 && <small>有 {invalid} 条认不出域名形状，保存时会丢掉（单段主机名如 localhost、纯 IP 不收）。</small>}
      {deduped > 0 && <small>有 {deduped} 条重复或超出 {MAX_BROWSER_CDP_DOMAINS} 条上限，保存时会合并。</small>}
      {!dirty && saved.length > 0 && <small className="browser-access__active">当前已授权：{saved.join("、")}</small>}
    </label>
    <div className="browser-access__foot">
      <Button type="button" disabled={!dirty || busy || !canManage} onClick={() => void save()}>
        {parsed.length ? "保存授权" : "收回授权"}
      </Button>
      {dirty && <Button type="button" variant="ghost" disabled={busy} onClick={() => setText(saved.join("\n"))}>
        放弃修改
      </Button>}
      {!canManage && <small>只有项目管理员能改这项授权。</small>}
    </div>
  </div></section>;
}
