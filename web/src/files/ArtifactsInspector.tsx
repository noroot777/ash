import { useEffect, useState } from "react";
import {
  ArrowClockwise,
  ArrowSquareOut,
  Browser,
  CaretDown,
  CaretRight,
  FileAudio,
  FilePdf,
  FileText,
  FileVideo,
  Images,
  SpinnerGap,
  Warning,
} from "@phosphor-icons/react";
import { api, type TaskArtifact } from "../lib/api.ts";
import { InspectorHeadActions } from "../inspector/index.ts";
import { formatSize } from "./fileModel.ts";
import {
  ARTIFACT_CONFIDENCE_LABEL,
  ARTIFACT_DOUBT_HINT,
  ARTIFACT_DOUBT_LABEL,
  ARTIFACT_DOUBTFUL_HEAD,
  ARTIFACT_ORIGIN_HINT,
  ARTIFACT_ORIGIN_LABEL,
  ARTIFACT_SCOPE_NOTE,
  alongsideOf,
  doubtOf,
  formatArtifactTime,
  groupArtifacts,
  useTaskArtifacts,
} from "./artifactModel.ts";

function KindGlyph({ kind }: { kind: TaskArtifact["kind"] }) {
  if (kind === "page") return <Browser size={20} aria-hidden="true" />;
  if (kind === "video") return <FileVideo size={20} aria-hidden="true" />;
  if (kind === "audio") return <FileAudio size={20} aria-hidden="true" />;
  if (kind === "pdf") return <FilePdf size={20} aria-hidden="true" />;
  if (kind === "doc") return <FileText size={20} aria-hidden="true" />;
  return <Images size={20} aria-hidden="true" />;
}

/**
 * 卡片上那块预览。
 *
 * 只有图片直接铺开——它是唯一「缩略图即内容」的一类，一眼就能认出是不是要找的那张。
 * 网页、音视频、PDF、文档给图标：在一条 280px 宽的侧栏里塞一个能播的播放器，既看不清也点不
 * 准，那些都该在中间栏摊开。
 */
function Thumb({ taskId, artifact }: { taskId: string; artifact: TaskArtifact }) {
  const [broken, setBroken] = useState(false);
  if (artifact.kind === "image" && !broken) {
    return (
      <img
        className="artifacts__thumb-img"
        src={api.taskFileRawUrl(taskId, artifact.path)}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setBroken(true)}
      />
    );
  }
  return <span className="artifacts__thumb-glyph"><KindGlyph kind={artifact.kind} /></span>;
}

/**
 * 「这个任务做出来了什么」——图片、网页、音视频、PDF、文档。
 *
 * 跟旁边的「文件」「改动」刻意不是同一个问题：文件树回答「工作目录里现在有什么」，改动
 * 回答「代码改了哪几行」，而产物回答「跑完这一趟，有什么可以直接看的东西」。一份生成的
 * 图在文件树里是几十行里的一行、在 diff 里是一句 `Binary files differ`，两边都等于没有。
 *
 * 怎么认出「是这个任务做的」（三路线索、各自的可信区间、为什么 mtime 只对被忽略的那一档
 * 成立）全在服务端 `task-artifacts.ts` 顶部，这里不复述。
 *
 * 点卡片一律走 `onOpenFile`，跟文件树同一个出口：中间栏那块地方本来就管着「摊开一份
 * 内容」，网页在那儿能整页渲染、视频能拉进度条，都不是侧栏做得了的事。
 */
export function ArtifactsInspector({
  taskId,
  activePath,
  onOpenFile,
  notify,
}: {
  taskId: string;
  activePath: string | null;
  /** 第二个参数是这一组的全部路径：中间栏据此摊开「上一张 / 下一张」。 */
  onOpenFile: (path: string, reel?: readonly string[]) => void;
  notify: (message: string) => void;
}) {
  const { result, error, loading, refresh } = useTaskArtifacts(taskId);
  const [refreshing, setRefreshing] = useState(false);
  const artifacts = result?.artifacts ?? [];
  const confirmed = artifacts.filter((artifact) => artifact.confidence !== "approx");
  const doubtful = artifacts.filter((artifact) => artifact.confidence === "approx");
  const alongside = alongsideOf(doubtful);
  const doubts = [...new Set(doubtful.map(doubtOf))];
  const [doubtfulOpen, setDoubtfulOpen] = useState(false);
  // 换了任务就重新折起来：上一个任务点开过，不代表这一个也要摊开。
  useEffect(() => setDoubtfulOpen(false), [taskId]);

  const reload = async () => {
    setRefreshing(true);
    try { await refresh(); } finally { setRefreshing(false); }
  };

  return (
    <div className="artifacts" aria-label="任务生成物">
      <InspectorHeadActions>
        <button
          type="button"
          className="artifacts__head-action"
          aria-label="重新扫描生成物"
          disabled={refreshing}
          onClick={() => void reload()}
        >
          <ArrowClockwise size={13} aria-hidden="true" />
        </button>
      </InspectorHeadActions>

      {error && (
        <p className="artifacts__state is-error">
          <Warning size={14} aria-hidden="true" />
          {error}
        </p>
      )}
      {/* 服务端那份 error 是「某一路线索没读成」，另外两路通常还有东西，所以它跟上面
          那条整块失败不是一回事：照常把列表铺出来，只在上面压一条提示。 */}
      {result?.error && <p className="artifacts__notice" role="status">{result.error}</p>}
      {/* 「读成了但没读完」必须单独说：空清单和「它什么都没做出来」在面板上长得一样。 */}
      {result?.incomplete.map((reason) => (
        <p key={reason} className="artifacts__notice" role="status">{reason}</p>
      ))}

      {loading && !result && <p className="artifacts__state"><SpinnerGap size={14} aria-hidden="true" />正在扫描…</p>}

      {!loading && !error && !confirmed.length && (
        <div className="artifacts__empty">
          <Images size={22} aria-hidden="true" />
          <b>{doubtful.length ? "没有能确定是它做的产物" : "还没有可以看的产物"}</b>
          <p>
            这里收的是任务做出来的图片、网页、音视频、PDF 和文档。
            {doubtful.length
              ? "下面那些拿不准是不是它做的，点开逐条看。"
              : result?.since
                ? "代码类的改动去「改动」那一格看。"
                : "这个任务还没跑过，等它写出东西来就会出现在这里。"}
          </p>
        </div>
      )}

      <ArtifactGroups taskId={taskId} artifacts={confirmed} activePath={activePath} onOpenFile={onOpenFile} notify={notify} />

      {/* 拿不准的默认折起来：共享目录上同时在跑的任务，候选可能有几百个，摊开就把它真正做出来
          的东西淹了。折起来不是藏起来——数目和原因都在标题上，点开逐条看。 */}
      {doubtful.length > 0 && (
        <section className="artifacts__doubtful">
          <button
            type="button"
            className="artifacts__doubtful-toggle"
            aria-expanded={doubtfulOpen}
            onClick={() => setDoubtfulOpen((open) => !open)}
          >
            {doubtfulOpen ? <CaretDown size={11} aria-hidden="true" /> : <CaretRight size={11} aria-hidden="true" />}
            {ARTIFACT_DOUBTFUL_HEAD}
            <small>{doubtful.length}</small>
          </button>
          {alongside.length > 0 && (
            <p className="artifacts__doubtful-note">同一时间也在跑：{alongside.join("、")}</p>
          )}
          {doubtfulOpen && (
            <ArtifactGroups taskId={taskId} artifacts={doubtful} activePath={activePath} onOpenFile={onOpenFile} notify={notify} />
          )}
        </section>
      )}

      {result?.truncated && <p className="artifacts__notice">产物太多，只列出了最近的一批</p>}

      {/* 整份清单凭什么算这个任务的：共享目录下它只是候选，这句不能省。 */}
      {result && artifacts.length > 0 && ARTIFACT_SCOPE_NOTE[result.scope] && (
        <p className="artifacts__notice is-scope">{ARTIFACT_SCOPE_NOTE[result.scope]}</p>
      )}

      {/* 角标上那三个词得有个地方解释一次——「未纳入版本管理」光看字面说不出它凭什么
          算这个任务的产物。放底下：认得的人扫一眼就过去了。 */}
      {artifacts.length > 0 && (
        <dl className="artifacts__legend">
          {(["working", "committed", "ignored"] as const).map((origin) => (
            <div key={origin}>
              <dt data-origin={origin}>{ARTIFACT_ORIGIN_LABEL[origin]}</dt>
              <dd>{ARTIFACT_ORIGIN_HINT[origin]}</dd>
            </div>
          ))}
          {/* 清单里真有那一种拿不准时才解释它——独占目录下一个都不会有，凭空多几行只会让人
              以为这份清单也靠猜。 */}
          {doubts.map((doubt) => (
            <div key={doubt}>
              <dt data-confidence="approx">{ARTIFACT_DOUBT_LABEL[doubt]}</dt>
              <dd>{ARTIFACT_DOUBT_HINT[doubt]}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/** 一份清单按类型分组铺开。确定的和拿不准的各用一份，翻页的那一串也各管各的。 */
function ArtifactGroups({
  taskId,
  artifacts,
  activePath,
  onOpenFile,
  notify,
}: {
  taskId: string;
  artifacts: readonly TaskArtifact[];
  activePath: string | null;
  onOpenFile: (path: string, reel?: readonly string[]) => void;
  notify: (message: string) => void;
}) {
  return groupArtifacts(artifacts).map((group) => (
    <section key={group.key} className="artifacts__group">
      <h4 className="artifacts__group-head">
        {group.label}
        <small>{group.items.length}</small>
      </h4>
      <div className="artifacts__grid">
        {group.items.map((artifact) => (
          <div key={artifact.path} className="artifacts__cell">
            <button
              type="button"
              className={`artifacts__card${artifact.path === activePath ? " is-active" : ""}`}
              aria-label={`打开 ${artifact.path}，${ARTIFACT_ORIGIN_LABEL[artifact.origin]}${
                artifact.confidence === "approx"
                  ? `，${ARTIFACT_CONFIDENCE_LABEL}：${ARTIFACT_DOUBT_LABEL[doubtOf(artifact)]}`
                  : ""
              }`}
              // 翻页的那一串按**这一组**给（图片跟图片翻、网页跟网页翻）：分组本来就是
              // 「同一类东西」的意思，跨组翻到一份 html 只会让人以为点错了。
              onClick={() => onOpenFile(artifact.path, group.items.map((item) => item.path))}
            >
              <span className="artifacts__thumb" data-kind={artifact.kind}>
                <Thumb taskId={taskId} artifact={artifact} />
              </span>
              <span className="artifacts__meta">
                <b>{artifact.name}</b>
                {artifact.dir && <small className="artifacts__dir">{artifact.dir}</small>}
                <small className="artifacts__facts">
                  <em data-origin={artifact.origin}>{ARTIFACT_ORIGIN_LABEL[artifact.origin]}</em>
                  {/* 拿不准的逐条说**为什么**拿不准：同样是候选，「时间是估的」和「同时有别的
                      任务」是两回事，用户据此决定要不要点开看。确定的不加角标——那是多数。 */}
                  {artifact.confidence === "approx" && (
                    // 解释走下面那张图例（跟 origin 那三个角标同一个做法）：原生 title 在每秒
                    // 重渲染的界面里永远弹不出来,`scripts/check-conventions.mjs` 也拦着。
                    <em data-confidence="approx">{ARTIFACT_DOUBT_LABEL[doubtOf(artifact)]}</em>
                  )}
                  {formatSize(artifact.size)}
                  {formatArtifactTime(artifact.mtime) && <span>{formatArtifactTime(artifact.mtime)}</span>}
                </small>
              </span>
            </button>
            {/* 交给本机应用打开：网页要完整保真（沙箱里字体、跨源请求都拿不到）、
                视频要系统播放器时的出口。 */}
            <button
              type="button"
              className="artifacts__open"
              aria-label={`用本机应用打开 ${artifact.name}`}
              onClick={async () => {
                try {
                  await api.openTaskFile(taskId, artifact.path, null);
                  notify("已交给本机应用打开");
                } catch (reason) {
                  notify(reason instanceof Error ? reason.message : String(reason));
                }
              }}
            >
              <ArrowSquareOut size={11} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </section>
      ));
}
