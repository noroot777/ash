import { useEffect, useState } from "react";
import type { ProjectView } from "@ash/shared";
import { Button } from "../components/ui.tsx";
import { DirectoryPickerButton } from "../components/DirectoryPickerButton.tsx";
import { useAuth } from "../auth/authContext.ts";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { PathHealthStatus, useDebouncedPathHealth } from "./PathHealthStatus.tsx";
import { ProjectGitSettings } from "./ProjectGitSettings.tsx";
import { PreviewCommandHelp } from "./PreviewCommandHelp.tsx";
import { WorkflowPicker, useWorkflows } from "../workflow/WorkflowPicker.tsx";
import { useHostInfo } from "../lib/useHostInfo.ts";

// 改名 / 改目录 / 默认起手式 / 删除项目都是**项目设置**,按权限表只给项目管理员与实例
// 管理员(§四)。后端本来就会 403,但把必然失败的控件摆在成员面前,他只会以为是自己点坏了
// —— 所以这一屏按 `project.myRole` 分两副面孔(第 6 轮审查 P3)。Git 那一段**同属这条线**:
// 提交署名、SSH key、HTTPS 令牌改一次,所有人所有任务的 worktree 都跟着变,所以 canManage
// 一路传下去(第 1 轮审查 P1);读侧仍然全员可见,理由见 ProjectGitSettings 顶部。
export function ProjectSettingsPanel({ project, onUpdated, onDeleted, notify }: {
  project: ProjectView;
  onUpdated: (project: ProjectView) => void;
  onDeleted: () => void;
  notify: (message: string) => void;
}) {
  const { state } = useAuth();
  const canManage = project.myRole === "admin";
  const [name, setName] = useState(project.name);
  const [repoPath, setRepoPath] = useState(project.repoPath);
  const [previewCommand, setPreviewCommand] = useState(project.previewCommand ?? "");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // 路径体检只对**改得动路径的人**有意义:它探的是「你现在填的这条路走不走得通」。
  // 成员那边不但没有提交按钮,`/projects/check` 还会按路径钳制回 403(它是一台目录
  // 探测器,多人模式下必须钳),于是控制台落一条 403、界面挂一句「暂时无法检查目录;
  // **仍可尝试提交**」—— 对一个提交不了的人说的完全是反话。传空串 = 根本不发这个请求。
  const pathHealth = useDebouncedPathHealth(canManage ? repoPath : "");
  const workflows = useWorkflows();
  const host = useHostInfo();
  // 多人模式下项目默认起手式只收系统自带那几条:自建的是个人资源,别人看不见,设成项目
  // 默认只会让别人的新任务**静默**落回系统默认(后端同样这么挡,见 project-routes.ts)。
  const pickable = state.mode === "multi" ? workflows.filter((item) => item.builtin) : workflows;
  // 项目行里设着一条**选不出来**的起手式:多数人解析不出它,新任务会静默落回系统默认。
  // 库还没拉到之前(workflows 为空)不下这个结论,否则每次进页面都先闪一句假警报。
  const legacyDefault = !!project.workflowId && workflows.length > 0
    && !pickable.some((item) => item.id === project.workflowId);
  // 依赖是 **project.id**，不是整个 project：这三个输入框是编辑中的草稿，只有「换了一个
  // 项目」才该被冲掉。以整个对象为依赖时，任何一次**对象身份变化**都会重置它们 ——
  // WorkspaceShell 拿到项目健康结果就会 `{...project, health}` 换一个新对象，而那个请求
  // 在进页面时发一次、之后每有任务结算（settlementVersion）还会再发。症状是：用户正在
  // 输预览命令，两三秒后输入框自己空了、保存按钮变灰，全程没有任何提示，看上去就是
  // 「这个框坏了」。名称和目录同样会被吞掉。
  //
  // 代价是「别人在服务端改了这个项目、而我正开着设置页」时我这边不跟着刷新 —— 那是显示
  // 得旧一点，比静默吞掉用户刚敲的字轻得多。
  useEffect(() => {
    setName(project.name);
    setRepoPath(project.repoPath);
    setPreviewCommand(project.previewCommand ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);
  const dirty = name.trim() !== project.name || repoPath.trim() !== project.repoPath;
  const previewDirty = previewCommand.trim() !== (project.previewCommand ?? "");
  const save = async () => {
    if (!name.trim() || !repoPath.trim() || !dirty) return;
    setBusy(true);
    try { onUpdated(await api.updateProject(project.id, { name: name.trim(), repoPath: repoPath.trim() })); notify("项目设置已保存"); }
    catch (error) { notify(error instanceof Error ? error.message : "项目设置保存失败"); }
    finally { setBusy(false); }
  };
  // 预览命令单独存：它跟名称/目录不是一批东西，攒在同一颗「保存更改」里，改完命令要先
  // 想起来还得按上面那颗按钮。空串存回 null = 回到自动识别。
  const savePreviewCommand = async () => {
    if (!previewDirty) return;
    setBusy(true);
    try { onUpdated(await api.updateProject(project.id, { previewCommand: previewCommand.trim() || null })); notify(previewCommand.trim() ? "预览命令已保存" : "预览命令已清空，恢复自动识别"); }
    catch (error) { notify(error instanceof Error ? error.message : "预览命令保存失败"); }
    finally { setBusy(false); }
  };
  // 起手式是下拉即存的：它没有「改到一半」的中间态，攒进「保存更改」反而让人以为没生效。
  const pickWorkflow = async (workflowId: string) => {
    setBusy(true);
    try { onUpdated(await api.updateProject(project.id, { workflowId: workflowId || null })); }
    catch (error) { notify(error instanceof Error ? error.message : "默认起手式保存失败"); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try { await api.deleteProject(project.id); onDeleted(); }
    catch (error) { notify(error instanceof Error ? error.message : "项目删除失败"); setBusy(false); }
  };
  // 预览命令是交给 **server 那台机器**的 shell 跑的（POSIX 是 `sh -lc`，Windows 是
  // `cmd /d /s /c`），所以这段说明也得按那台机器的方言写：cmd 只认 `%PORT%`，`$PORT`
  // 在那边是个字面量；后台任务、分隔符同理。照着一份 POSIX 文案抄下去的用户，在
  // Windows 上会得到一条必然起不来的命令，而且从报错里看不出是文案的锅。
  // 拿不到 host 信息时按 POSIX 说（绝大多数部署如此），不空着也不猜。
  const isWindows = host?.platform === "win32";
  const ref = (name: string) => isWindows ? `%${name}%` : `$${name}`;
  const combinedHint = isWindows
    ? `start "" /b cmd /c "cd /d back && set SERVER_PORT=%PORT2%&&mvn spring-boot:run" & cd /d front && set VITE_APP_API_URL=%URL2%&&pnpm run dev -- --port %PORT%`
    : "(cd back && SERVER_PORT=$PORT2 mvn spring-boot:run &) ; cd front && VITE_APP_API_URL=$URL2 pnpm run dev -- --port $PORT";
  return (
    <>
      <header className="settings-heading"><div><h1>项目设置</h1><p>项目目录是所有任务的默认运行位置，也是 worktree 与 diff 的根。</p></div></header>
      {!canManage && (
        <section className="settings-section"><div className="settings-card">
          <div className="settings-row"><div>
            <b>你在这个项目里是成员</b>
            <small>项目名称、工作目录、默认起手式、预览命令、Git 身份与凭证、删除项目只有项目管理员能改；下面按只读展示。要改就找一位项目管理员。</small>
          </div></div>
        </div></section>
      )}
      <section className="settings-section"><h2>基本信息</h2><div className="settings-card">
        <label className="settings-field"><span>项目名称</span><input value={name} readOnly={!canManage} onChange={(event) => setName(event.target.value)} /></label>
        <label className="settings-field"><span>工作目录</span><span className="path-field"><input className="mono" value={repoPath} readOnly={!canManage} onChange={(event) => setRepoPath(event.target.value)} />{canManage && <DirectoryPickerButton startIn={repoPath} onPick={setRepoPath} disabled={busy} notify={notify} />}</span></label>
        {canManage && <PathHealthStatus path={repoPath} state={pathHealth} />}
        {canManage && <div className="settings-card-foot"><span>修改目录不会移动磁盘文件，只会改变后续任务的 cwd。</span><Button variant="primary" disabled={!dirty || !name.trim() || !repoPath.trim() || busy} onClick={() => void save()}>{busy ? "保存中…" : "保存更改"}</Button></div>}
      </div></section>
      <section className="settings-section"><h2>默认起手式</h2><div className="settings-card">
        <div className="settings-row">
          <div>
            <b>这个项目的新任务默认走哪条线</b>
            <small>
              {canManage && state.mode === "multi"
                ? "没设就跟着系统默认走；只能选系统自带的那几条——自建起手式是个人资源，别人看不见，设成项目默认对他们不生效"
                : "没设就跟着系统默认走；每张新任务仍可单独换，换了也只影响那一张"}
            </small>
            {/* 存量值:自用模式转过来的、或修复之前写进去的自建/别人的起手式。它对多数人
                解析不出来,新任务会静默落回系统默认 —— 不说破的话,项目管理员会一直以为
                这个项目统一走着那条线(第 6 轮审查 P1)。 */}
            {legacyDefault && (
              <small>当前这条已经不作数了：它不在可选清单里（自建或别人的个人起手式），大家的新任务实际走的是系统默认。{canManage ? "重新选一条即可修正。" : ""}</small>
            )}
          </div>
          <WorkflowPicker
            value={project.workflowId ?? ""}
            items={pickable}
            inheritLabel="跟着系统默认走"
            disabled={busy || !canManage}
            onChange={(workflowId) => void pickWorkflow(workflowId)}
          />
        </div>
      </div></section>
      <section className="settings-section"><h2>预览命令</h2><div className="settings-card">
        <label className="settings-field">
          <span>「打开预览」跑哪条命令</span>
          <input
            className="mono"
            value={previewCommand}
            readOnly={!canManage}
            placeholder="留空 = 由 ash 自己认（认出恰好一个才用）"
            onChange={(event) => setPreviewCommand(event.target.value)}
          />
        </label>
        <PreviewCommandHelp key={project.id}>
          <section>
            <h3>自动识别启动命令</h3>
            <p>
              留空时，ash 会按各语言的惯例识别启动命令：Maven 的 <code className="mono">spring-boot:run</code>、Gradle 的{" "}
              <code className="mono">bootRun</code>、Django 的 <code className="mono">runserver</code>、FastAPI 的{" "}
              <code className="mono">uvicorn</code>、Flask、<code className="mono">go run</code>、<code className="mono">cargo run</code>、
              <code className="mono">dotnet run</code>、Laravel 的 <code className="mono">artisan</code>、Rails 的{" "}
              <code className="mono">bin/rails</code>、Node 的 dev / start 脚本。
            </p>
            <p><b>只有恰好识别出一个启动项时才会自动使用。</b>如果前后端并列，或 Maven 多个模块各有一个应用，ash 会列出候选项，请选择需要的命令填入输入框。</p>
          </section>
          <section>
            <h3>命令在哪里执行</h3>
            <p>命令在任务工作区（worktree）的根目录执行，使用服务端所在机器的 shell。支持 cd、<code className="mono">&amp;&amp;</code> 和后台任务；ash 会注入 <code className="mono">BROWSER=none</code>。</p>
          </section>
          <section>
            <h3>预览端口与服务地址</h3>
            <p>ash 会为预览分配一组端口。<code className="mono">{ref("PORT")}</code> 用于要在浏览器中查看的服务；辅助服务使用 <code className="mono">{ref("PORT2")}</code>…<code className="mono">{ref("PORT5")}</code>。</p>
            <p>辅助服务还提供对应的地址变量 <code className="mono">{ref("URL2")}</code>…<code className="mono">{ref("URL5")}</code>，例如 <code className="mono">{ref("URL2")}</code> 就是 <code className="mono">http://localhost:{ref("PORT2")}</code>。</p>
          </section>
          <section>
            <h3>同时启动前后端</h3>
            <p>将启动步骤写成一条命令：辅助服务放到后台，需要预览的服务放在最后。例如：</p>
            <pre><code className="mono">{combinedHint}</code></pre>
            <p>前端连接后端的变量名取决于项目配置（Vite 项目通常使用 <code className="mono">VITE_*_URL</code>）。请按项目实际使用的名称填写，ash 只负责提供服务地址。</p>
          </section>
          <section>
            <h3>把端口传给运行时</h3>
            <p>
              不同运行时的端口配置方式不同。ash 会以常见的环境变量名称传入同一个端口：
              <code className="mono">PORT</code>（Node / Go / Rust）、<code className="mono">SERVER_PORT</code>（Spring Boot）、
              <code className="mono">ASPNETCORE_URLS</code>（ASP.NET Core）、<code className="mono">QUARKUS_HTTP_PORT</code>、
              <code className="mono">FLASK_RUN_PORT</code>。
            </p>
            <p>Vite、Angular、Django、Laravel、Rails 等需要通过命令行参数指定端口，请把 <code className="mono">{ref("PORT")}</code> 写进命令。自动识别的命令已包含这些参数，手动填写时也需要保留。
          {isWindows && " 上面这些写法是按 Windows 的 cmd 给的（ash 就跑在 Windows 上），POSIX 那套 $PORT 在这儿不展开。"}
            </p>
          </section>
          <section>
            <h3>启动失败时排查</h3>
            <p>打开任务底部的「预览日志」，可以查看实际执行的命令、注入的端口和命令输出。启动失败的日志也会保留。</p>
          </section>
        </PreviewCommandHelp>
        {canManage && <div className="settings-card-foot"><span>改了只影响之后新开的预览，已经开着的那个不受影响。</span><Button variant="primary" disabled={!previewDirty || busy} onClick={() => void savePreviewCommand()}>{busy ? "保存中…" : "保存预览命令"}</Button></div>}
      </div></section>
      <ProjectGitSettings projectId={project.id} canManage={canManage} notify={notify} />
      {canManage && (
        <section className="settings-section"><h2>危险操作</h2><div className="settings-card settings-danger-row"><div><b>删除项目</b><small>删除项目记录，以及它下面的任务、分组和运行记录；不会删除仓库目录。</small></div><Button variant="danger" disabled={busy} onClick={() => setConfirmDelete(true)}>删除项目</Button></div></section>
      )}
      {confirmDelete && <ConfirmDialog title="删除项目" message={`确定删除“${project.name}”？项目下的任务、分组和运行记录会一并删除，仓库目录不会被删除。`} confirmLabel="删除项目" danger busy={busy} onClose={() => setConfirmDelete(false)} onConfirm={() => void remove()} />}
    </>
  );
}
