import { useCallback, useEffect, useState } from "react";
import type { ProjectView, SkillScanOverview, SkillScanRow, SkillSource } from "@ash/shared";
import { Button } from "../components/ui.tsx";
import { api } from "../lib/api.ts";

// 设置页里的「技能扫描」一块：刷新间隔 + 立即重新扫描 + 每个 **CLI 类型**扫到了什么。
//
// 一行 = 一个 CLI 类型，归并规则与理由写在 shared 的
// `SkillScanRow` 注释里。这里只说界面上的取舍：被归并掉的 profile 名字仍然列在副行，
// 好让人确认「我注册的那几个都在这一行里」，而不是怀疑漏扫了谁。

// 按小时给档：装新技能是低频动作，等不及有下面那颗「立即重新扫描」，以及
// 「关掉输入框再打开」——那一下必然重拉。
const REFRESH_CHOICES = [
  { value: 0, label: "不自动刷新" },
  { value: 3600, label: "每 1 小时" },
  { value: 2 * 3600, label: "每 2 小时" },
  { value: 4 * 3600, label: "每 4 小时" },
  { value: 8 * 3600, label: "每 8 小时" },
  { value: 12 * 3600, label: "每 12 小时" },
  { value: 24 * 3600, label: "每 24 小时" },
];

const SOURCE_LABEL: Record<SkillSource, string> = {
  project: "项目",
  user: "个人",
  plugin: "插件",
  builtin: "内置",
};

// 老库里存过秒级的值(或有人手改过 DB)时补一档，免得下拉显示空白。
function choicesFor(seconds: number) {
  if (REFRESH_CHOICES.some((choice) => choice.value === seconds)) return REFRESH_CHOICES;
  const label = seconds % 3600 === 0 ? `每 ${seconds / 3600} 小时` : `每 ${seconds} 秒`;
  return [...REFRESH_CHOICES, { value: seconds, label }].sort((a, b) => a.value - b.value);
}

function sourceSummary(row: SkillScanRow): string {
  const parts = (Object.keys(SOURCE_LABEL) as SkillSource[])
    .filter((source) => row.bySource[source] > 0)
    .map((source) => `${SOURCE_LABEL[source]} ${row.bySource[source]}`);
  return parts.join(" · ");
}

export function SkillScanCard({
  seconds,
  loading,
  readOnly,
  onChangeSeconds,
  notify,
}: {
  seconds: number;
  loading: boolean;
  /** 多人模式下这是**机器级**轮询行为(§八 实例面),普通用户只读。 */
  readOnly?: boolean;
  onChangeSeconds: (seconds: number) => Promise<void>;
  notify: (message: string) => void;
}) {
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [projectId, setProjectId] = useState("");
  const [overview, setOverview] = useState<SkillScanOverview | null>(null);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    api.projects().then(setProjects).catch(() => setProjects([]));
  }, []);

  const load = useCallback(
    async (rescan: boolean) => {
      setScanning(true);
      try {
        const next = rescan ? await api.rescanSkills(projectId) : await api.skillsOverview(projectId);
        setOverview(next);
        if (rescan) {
          const total = next.rows.reduce((sum, row) => sum + row.count, 0);
          notify(`已重新扫描：${next.rows.length} 个 CLI，共 ${total} 条技能`);
        }
      } catch (error) {
        notify(error instanceof Error ? error.message : "技能扫描失败");
      } finally {
        setScanning(false);
      }
    },
    [notify, projectId],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  return (
    <section className="settings-section">
      <h2>技能扫描</h2>
      <div className="settings-card">
        <div className="settings-row">
          <div>
            <b>
              输入框里 <code>/技能</code> 清单多久刷一次
            </b>
            <small>
              指的是页面隔多久去问一次服务端，不是服务端多久扫一次盘（它每次都真扫，命中缓存约 0.5ms）。
              装了新技能等不及，用下面的「立即重新扫描」，或者关掉输入框再打开——那一下一定是新的
              {readOnly && <><br />这一项是整台机器的轮询行为，只有实例管理员能改。</>}
            </small>
          </div>
          <select
            value={String(seconds)}
            disabled={loading || readOnly}
            aria-label="技能清单刷新间隔"
            onChange={(event) => void onChangeSeconds(Number(event.target.value))}
          >
            {choicesFor(seconds).map((choice) => (
              <option key={choice.value} value={String(choice.value)}>
                {choice.label}
              </option>
            ))}
          </select>
        </div>

        <div className="settings-row">
          <div>
            <b>每个 CLI 扫到了什么</b>
            <small>
              技能目录按 CLI 类型定，同一个 CLI 换供应商不会换出另一份技能，所以按类型合成一行。
              项目级技能来自所选项目仓库根的{" "}
              <code>.claude/skills</code>
            </small>
          </div>
          <span className="skill-scan-actions">
            <select
              value={projectId}
              aria-label="按项目查看技能"
              onChange={(event) => setProjectId(event.target.value)}
            >
              <option value="">不限项目（只看个人/插件级）</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <Button variant="secondary" disabled={scanning} onClick={() => void load(true)}>
              {scanning ? "扫描中…" : "立即重新扫描"}
            </Button>
          </span>
        </div>

        {overview?.rows.map((row) => (
          <div className="skill-scan-row" key={row.agentType}>
            <div className="skill-scan-who">
              <b>{row.agentType}</b>
              <em>{row.executors.length ? row.executors.join(" · ") : "未注册执行器"}</em>
            </div>
            <div className="skill-scan-what">
              {!row.scannable ? (
                <span className="skill-scan-note">这个 CLI 没有技能目录约定，菜单里只有 ash 自己的命令</span>
              ) : row.count === 0 ? (
                <span className="skill-scan-note">没扫到技能</span>
              ) : (
                <>
                  <span className="skill-scan-count">
                    {row.count} 条
                    {sourceSummary(row) && <i>{sourceSummary(row)}</i>}
                  </span>
                  <span className="skill-scan-sample">
                    {row.sample.join(" ")}
                    {row.count > row.sample.length && ` …还有 ${row.count - row.sample.length} 条`}
                  </span>
                </>
              )}
            </div>
          </div>
        ))}

        {overview && (
          <div className="settings-card-foot">
            <span>
              {overview.cwd ? `项目根：${overview.cwd}` : "未选项目：只扫了个人级与插件级技能"}
            </span>
            <span>扫描时间 {new Date(overview.scannedAt).toLocaleString()}</span>
          </div>
        )}
      </div>
    </section>
  );
}
