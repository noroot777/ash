// 首启向导的后半段。前半段(自用 / 多人)在 `auth/SetupWizard.tsx`,这一段接着问三件
// 装完就必须定下来的事:供应商 → 执行器 → 项目。
//
// 为什么不是「让用户自己去设置页逛一圈」:装完打开 ash,屏幕上只有一句「还没有可用
// 项目」。照它建完项目,下一步是新建任务 —— 而真正拦着他的是「一个执行器都没注册」,
// 那句话在另一个页面里。这三件事有固定的依赖顺序(供应商挂到执行器上,执行器在项目
// 目录里跑),按顺序问一遍比留三处空状态各喊一句都准。
//
// 每一步都**可以空着过**:CLI 自带订阅账号的人不需要供应商,这台机器还没装 CLI 的人
// 注册不出执行器。所以向导里没有一处硬门禁,只有导轨上的勾和最后那行「还差什么」。
// 真正的闸在工作台原有的位置上(派任务时的执行器闸、建任务时的项目闸)。
//
// 走完(或跳过)之后落 `onboardedAt`,判据与放行见 `server/src/onboarding.ts`。
import { useCallback, useEffect, useState } from "react";
import type { AgentExecutorProfile, LlmProvider, ProjectView } from "@ash/shared";
import { Check } from "@phosphor-icons/react";
import { Button } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { useHostCliIsolated } from "../lib/useHostCliIsolated.ts";
import { CreateProjectDialog } from "../overlays/CreateProjectDialog.tsx";
import { useToast, WorkspaceToast } from "../workspace/WorkspaceToast.tsx";
import { FIRST_RUN_STEPS, STEP_LABEL, stepGap, stepSettled, type FirstRunStep } from "./firstRunSteps.ts";
import { ExecutorStep } from "./ExecutorStep.tsx";
import { ProjectStep } from "./ProjectStep.tsx";
import { ProviderStep } from "./ProviderStep.tsx";

/**
 * 每一站的抬头。供应商那句分两种说法 —— **隔离档下第一句是假话**:多人模式关掉
 * 「共用宿主机 CLI」之后,宿主机那份订阅对任务一律不算数,执行器不挂供应商就派不出
 * 任务(`server/src/auth/dispatch-gate.ts`)。照着「默认用 CLI 自己的账号」跳过这一站
 * 的人,会在下一站拿到一排注册完却跑不起来的执行器。
 */
function headlineOf(step: FirstRunStep, isolated: boolean): { title: string; hint: string } {
  if (step === "provider") {
    return {
      title: "模型从哪儿来",
      hint: isolated
        ? "这台 ash 隔离了宿主机的 CLI 订阅：任务要跑起来，执行器必须挂一家自带 Key 的供应商。"
        : "执行器默认用 CLI 自己的订阅账号；要走中转站或第三方 API，在这里登记一次。",
    };
  }
  if (step === "executor") {
    return { title: "谁来干活", hint: "ash 自己不调模型，任务全交给这些本地 CLI 执行。" };
  }
  return {
    title: "在哪儿干活",
    hint: "任务、随手记和分组都挂在项目下，项目目录就是任务的默认运行位置。",
  };
}

export function FirstRunWizard({ onDone }: { onDone: () => Promise<boolean> }) {
  const { toasts, notify, dismiss } = useToast();
  const [step, setStep] = useState<FirstRunStep>("provider");
  const [providers, setProviders] = useState<LlmProvider[]>([]);
  const [profiles, setProfiles] = useState<AgentExecutorProfile[]>([]);
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState("");
  const [finishing, setFinishing] = useState(false);
  const [reloads, setReloads] = useState(0);
  // 「宿主机的 CLI 订阅算不算数」问前端那一份单点(lib/hostCliPolicy.ts),不在这里
  // 拿 mode + sharedHostCli 自己兜第二份 —— 下面那发 `api.settings()` 正是教会它的
  // 那一下(读设置的路径统一经 settingsSync 喂给它)。
  const isolated = useHostCliIsolated();

  useEffect(() => {
    let alive = true;
    setLoading(true);
    // 一份读失败不该把另外两份也一起丢掉:`Promise.all` 的那一版任意一条 500,整屏
    // 就退成三个空列表 + 一句 toast,用户看到的是「我什么都没配过」而不是「没读出来」,
    // 而且页面上没有任何重试入口(第 1 轮审查)。所以逐份落地,失败的那几份单独报。
    // 第四份 `api.settings()` 不往这里存任何东西:它经 settingsSync 把「CLI 额度」
    // 那一档喂给 hostCliPolicy,上面 `isolated` 订的就是那一份。
    void Promise.allSettled([api.llmProviders(), api.agents(), api.projects(), api.settings()])
      .then(([provider, profile, project]) => {
        if (!alive) return;
        if (provider.status === "fulfilled") setProviders(provider.value);
        if (profile.status === "fulfilled") setProfiles(profile.value);
        if (project.status === "fulfilled") {
          setProjects(project.value);
          // 已经有项目(多人模式下被加进了别人的项目)时先选上第一个,这样最后那颗按钮
          // 永远有个落点 —— 否则「进入 ash」会把人丢进一个没选中项目的工作台。
          setProjectId((current) => current ?? project.value[0]?.id ?? null);
        }
        const failed = [
          provider.status === "rejected" ? "供应商" : "",
          profile.status === "rejected" ? "执行器" : "",
          project.status === "rejected" ? "项目" : "",
        ].filter(Boolean);
        setLoadFailed(failed.length ? `${failed.join("、")}没读出来` : "");
        setLoading(false);
      });
    return () => { alive = false; };
  }, [reloads]);

  const reloadProviders = useCallback(async () => {
    setProviders(await api.llmProviders());
  }, []);

  const finish = async () => {
    setFinishing(true);
    try {
      // 用户表过态的凭据。写不进去就别往下走 —— 否则下次刷新向导又回来,而他以为自己
      // 已经走完了。
      await api.patchSettings({ onboardedAt: new Date().toISOString() });
    } catch (error) {
      notify(error instanceof Error ? error.message : "保存向导状态失败");
      setFinishing(false);
      return;
    }
    // 刚挑的那个项目写进 URL:工作台的初始项目就是从 query 里读的(readUrlSelection),
    // 不写的话它会自己落到列表第一个,用户这一下就白点了。
    if (projectId) window.history.replaceState(null, "", `/?project=${encodeURIComponent(projectId)}`);
    // 表态已经存下了,这一下只差「重新确认身份」。它失败就把按钮还给用户再按一次 ——
    // 把回执丢掉的那一版会永久停在「正在进入…」上,服务恢复了也动不了(见 authContext)。
    if (!(await onDone())) {
      notify("配置已保存，但没能重新确认身份；服务恢复后再按一次「进入 ash」。");
      setFinishing(false);
    }
  };

  const index = FIRST_RUN_STEPS.indexOf(step);
  const last = index === FIRST_RUN_STEPS.length - 1;
  const settled = { providers, profiles, projects };
  // 最后一屏才报「还差什么」:中间几步报等于一路催着,而真正该说清后果的只有出口那一下。
  const pending = last
    ? FIRST_RUN_STEPS.map((candidate) => stepGap(candidate, settled)).filter((gap): gap is string => !!gap)
    : [];

  return (
    <div className="onboarding-shell">
      <div className="onboarding-card">
        <nav className="onboarding-rail" aria-label="首次配置的三步">
          {FIRST_RUN_STEPS.map((candidate, candidateIndex) => {
            const done = stepSettled(candidate, settled);
            return (
              <button
                key={candidate}
                type="button"
                className={`onboarding-rail-step${candidate === step ? " is-on" : ""}${done ? " is-done" : ""}`}
                aria-current={candidate === step ? "step" : undefined}
                onClick={() => setStep(candidate)}
              >
                <i aria-hidden="true">{done ? <Check size={11} weight="bold" /> : candidateIndex + 1}</i>
                {STEP_LABEL[candidate]}
              </button>
            );
          })}
        </nav>

        <header className="onboarding-head">
          <h1>{headlineOf(step, isolated).title}</h1>
          <p>{headlineOf(step, isolated).hint}</p>
        </header>

        <div className="onboarding-body">
          {loadFailed && !loading && (
            <p className="onboarding-retry" role="status">
              {loadFailed}
              <Button onClick={() => setReloads((n) => n + 1)}>重试</Button>
            </p>
          )}
          {loading ? <p className="onboarding-muted">正在读取当前配置…</p> : step === "provider" ? (
            <ProviderStep providers={providers} onChanged={reloadProviders} notify={notify} />
          ) : step === "executor" ? (
            <ExecutorStep
              profiles={profiles}
              providers={providers}
              onProfileAdded={(profile) => setProfiles((current) => [...current, profile])}
              onProfileChanged={(profile) => setProfiles((current) =>
                current.map((row) => row.id === profile.id ? profile : row))}
              notify={notify}
            />
          ) : (
            <ProjectStep
              projects={projects}
              selectedId={projectId}
              onSelect={setProjectId}
              onCreate={() => setCreating(true)}
            />
          )}
        </div>

        <footer className="onboarding-foot">
          <p className="onboarding-muted" role="status">
            {pending.length ? `${pending.join("；")}，之后可以在设置里补。` : ""}
          </p>
          <Button
            variant="primary"
            disabled={loading || finishing}
            onClick={() => last ? void finish() : setStep(FIRST_RUN_STEPS[index + 1])}
          >
            {last ? (finishing ? "正在进入…" : "进入 ash") : "下一步"}
          </Button>
        </footer>
      </div>

      {creating && (
        <CreateProjectDialog
          projects={projects}
          notify={notify}
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            setProjects((current) => current.some((row) => row.id === created.id) ? current : [...current, created]);
            setProjectId(created.id);
            setCreating(false);
          }}
        />
      )}

      <WorkspaceToast toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
