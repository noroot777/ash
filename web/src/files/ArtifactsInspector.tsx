import { useEffect, useState } from "react";
import {
  ArrowClockwise,
  ArrowSquareOut,
  File,
  FileVideo,
  Images,
} from "@phosphor-icons/react";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { api, type TaskArtifact } from "../lib/api.ts";
import { InspectorHeadActions } from "../inspector/index.ts";
import { InspButton, InspGo, InspNone, InspNote, InspSec, InspTool } from "../inspector/parts.tsx";
import { formatInstant } from "../task-detail/utils.ts";
import { formatSize } from "./fileModel.ts";
import {
  ARTIFACT_CONFIDENCE_LABEL,
  ARTIFACT_DOUBT_HINT,
  ARTIFACT_DOUBT_LABEL,
  ARTIFACT_DOUBTFUL_HEAD,
  ARTIFACT_ORIGIN_HINT,
  ARTIFACT_ORIGIN_LABEL,
  ARTIFACT_ORIGIN_SHORT,
  ARTIFACT_SCOPE_NOTE,
  alongsideOf,
  doubtOf,
  groupArtifacts,
  useTaskArtifacts,
} from "./artifactModel.ts";

/** 只有图片和视频出缩略图：它们是「一眼认得出是不是要找的那张」的那两类。 */
const THUMB_KINDS = new Set<TaskArtifact["kind"]>(["image", "video"]);

type OpenFile = (path: string, reel?: readonly string[]) => void;

/**
 * 指上去才看得到的那几样：来源（全称和它凭什么算这个任务的）、在哪个目录、什么时候生成的；
 * 拿不准归属的那条再加一句为什么拿不准。
 */
function artifactTip(artifact: TaskArtifact) {
  const where = [ARTIFACT_ORIGIN_LABEL[artifact.origin], artifact.dir || "工作目录根", formatInstant(artifact.mtime)]
    .filter(Boolean)
    .join(" · ");
  return (
    <>
      <span>{where}</span>
      <br />
      <span>{ARTIFACT_ORIGIN_HINT[artifact.origin]}</span>
      {artifact.confidence === "approx" && (
        <>
          <br />
          <span>{ARTIFACT_CONFIDENCE_LABEL}：{ARTIFACT_DOUBT_LABEL[doubtOf(artifact)]}——{ARTIFACT_DOUBT_HINT[doubtOf(artifact)]}</span>
        </>
      )}
    </>
  );
}

function openLabel(artifact: TaskArtifact) {
  return `打开 ${artifact.path}，${ARTIFACT_ORIGIN_LABEL[artifact.origin]}${
    artifact.confidence === "approx" ? `，${ARTIFACT_CONFIDENCE_LABEL}：${ARTIFACT_DOUBT_LABEL[doubtOf(artifact)]}` : ""
  }`;
}

/**
 * 交给本机应用打开：网页要完整保真（沙箱里字体、跨源请求都拿不到）、视频要系统播放器时的出口。
 * 跟打开那一下是**兄弟**不是子元素：套在按钮里浏览器会把它拎出去，点哪儿都变成点了整行。
 */
function OpenLocally({ taskId, artifact, notify }: { taskId: string; artifact: TaskArtifact; notify: (message: string) => void }) {
  return (
    <InspTool
      label={`用本机应用打开 ${artifact.name}`}
      className="artifacts__open"
      onClick={async () => {
        try {
          await api.openTaskFile(taskId, artifact.path, null);
          notify("已交给本机应用打开");
        } catch (reason) {
          notify(reason instanceof Error ? reason.message : String(reason));
        }
      }}
    >
      <ArrowSquareOut aria-hidden="true" />
    </InspTool>
  );
}

/** 图片铺原图（缩成方块），视频给一块带播放标记的底；坏了的图退回图标。 */
function ThumbFace({ taskId, artifact }: { taskId: string; artifact: TaskArtifact }) {
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
  return artifact.kind === "video" ? <FileVideo aria-hidden="true" /> : <Images aria-hidden="true" />;
}

function ThumbItem({ taskId, artifact, reel, active, onOpenFile, notify }: {
  taskId: string;
  artifact: TaskArtifact;
  reel: readonly string[];
  active: boolean;
  onOpenFile: OpenFile;
  notify: (message: string) => void;
}) {
  const tip = useHoverTip();
  const from = ARTIFACT_ORIGIN_SHORT[artifact.origin];
  return (
    <div className="artifacts__shot">
      <button
        type="button"
        className={`artifacts__card artifacts__thumb-card${active ? " is-active" : ""}`}
        aria-label={openLabel(artifact)}
        aria-current={active || undefined}
        {...tip.anchorProps}
        onClick={() => onOpenFile(artifact.path, reel)}
      >
        <span className="artifacts__thumb" data-kind={artifact.kind}><ThumbFace taskId={taskId} artifact={artifact} /></span>
        <span className="insp-cut artifacts__name">{artifact.name}</span>
        <small className="artifacts__facts">{from ? `${from} · ` : ""}{formatSize(artifact.size)}</small>
      </button>
      <HoverTip at={tip.at}>{artifactTip(artifact)}</HoverTip>
      <OpenLocally taskId={taskId} artifact={artifact} notify={notify} />
    </div>
  );
}

function LineItem({ taskId, artifact, reel, active, onOpenFile, notify }: {
  taskId: string;
  artifact: TaskArtifact;
  reel: readonly string[];
  active: boolean;
  onOpenFile: OpenFile;
  notify: (message: string) => void;
}) {
  const tip = useHoverTip({ placement: "left" });
  const from = ARTIFACT_ORIGIN_SHORT[artifact.origin];
  return (
    <li className="artifacts__file">
      <button
        type="button"
        className={`insp-go insp-row artifacts__card artifacts__line${active ? " is-active" : ""}`}
        aria-label={openLabel(artifact)}
        aria-current={active || undefined}
        {...tip.anchorProps}
        onClick={() => onOpenFile(artifact.path, reel)}
      >
        <File aria-hidden="true" />
        <span className="insp-cut">{artifact.name}</span>
        {from && <span className="artifacts__from">{from}</span>}
        <span className="insp-meta">{formatSize(artifact.size)}</span>
      </button>
      <HoverTip at={tip.at}>{artifactTip(artifact)}</HoverTip>
      <OpenLocally taskId={taskId} artifact={artifact} notify={notify} />
    </li>
  );
}

/**
 * 「这个任务做出来了什么」——图片、网页、音视频、PDF、文档。按类型分节；图片和视频出缩略图，
 * 其余一行一条：名字、大小，还没提交的多两个字（未提交 / 未跟踪）。在哪个目录、什么时候生成
 * 的、来源凭什么算它的，指上去再看。
 *
 * 跟旁边的「文件」「改动」刻意不是同一个问题：文件树回答「工作目录里现在有什么」，改动
 * 回答「代码改了哪几行」，而产物回答「跑完这一趟，有什么可以直接看的东西」。一份生成的
 * 图在文件树里是几十行里的一行、在 diff 里是一句 `Binary files differ`，两边都等于没有。
 *
 * 怎么认出「是这个任务做的」（三路线索、各自的可信区间、为什么 mtime 只对被忽略的那一档
 * 成立）全在服务端 `task-artifacts.ts` 顶部，这里不复述。
 *
 * 点开一律走 `onOpenFile`，跟文件树同一个出口：中间栏那块地方本来就管着「摊开一份内容」，
 * 网页在那儿能整页渲染、视频能拉进度条，都不是侧栏做得了的事。
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
  onOpenFile: OpenFile;
  notify: (message: string) => void;
}) {
  const { result, error, loading, refresh } = useTaskArtifacts(taskId);
  const [refreshing, setRefreshing] = useState(false);
  const artifacts = result?.artifacts ?? [];
  const confirmed = artifacts.filter((artifact) => artifact.confidence !== "approx");
  const doubtful = artifacts.filter((artifact) => artifact.confidence === "approx");
  const alongside = alongsideOf(doubtful);
  const [doubtfulOpen, setDoubtfulOpen] = useState(false);
  // 换了任务就重新折起来：上一个任务点开过，不代表这一个也要摊开。
  useEffect(() => setDoubtfulOpen(false), [taskId]);

  const reload = async () => {
    setRefreshing(true);
    try { await refresh(); } finally { setRefreshing(false); }
  };

  return (
    <div className="insp-pane artifacts" aria-label="任务生成物">
      <InspectorHeadActions>
        <InspTool label="重新扫描生成物" disabled={refreshing} onClick={() => void reload()}>
          <ArrowClockwise aria-hidden="true" />
        </InspTool>
      </InspectorHeadActions>

      {error && (
        <InspNote tone="bad" role="alert" action={<InspButton size="sm" disabled={refreshing} onClick={() => void reload()}>重试</InspButton>}>
          {error}
        </InspNote>
      )}
      {/* 服务端那份 error 是「某一路线索没读成」，另外两路通常还有东西，所以它跟上面
          那条整块失败不是一回事：照常把列表铺出来，只在上面压一条提示。 */}
      {result?.error && <InspNote tone="warn" role="status">{result.error}</InspNote>}
      {/* 「读成了但没读完」必须单独说：空清单和「它什么都没做出来」在面板上长得一样。 */}
      {result?.incomplete.map((reason) => <InspNote key={reason} tone="warn" role="status">{reason}</InspNote>)}

      {loading && !result && <InspNone>正在扫描…</InspNone>}

      {!loading && !error && !confirmed.length && (
        <InspNone>
          {doubtful.length
            ? "没有能确定是它做的产物，拿不准的收在下面。"
            : result?.since ? "还没有可以直接看的产物。" : "这个任务还没跑过。"}
        </InspNone>
      )}

      <ArtifactGroups taskId={taskId} artifacts={confirmed} activePath={activePath} onOpenFile={onOpenFile} notify={notify} />

      {/* 拿不准的默认折起来：共享目录上同时在跑的任务，候选可能有几百个，摊开就把它真正做出来
          的东西淹了。折起来不是藏起来——数目在那一行上，每一条为什么拿不准指上去看。 */}
      {doubtful.length > 0 && (
        <section className="artifacts__doubtful">
          <InspGo aria-expanded={doubtfulOpen} meta={doubtful.length} onClick={() => setDoubtfulOpen((open) => !open)}>
            {ARTIFACT_DOUBTFUL_HEAD}
          </InspGo>
          {alongside.length > 0 && <p className="insp-hint">同一时间也在跑：{alongside.join("、")}</p>}
          {doubtfulOpen && (
            <ArtifactGroups taskId={taskId} artifacts={doubtful} activePath={activePath} onOpenFile={onOpenFile} notify={notify} />
          )}
        </section>
      )}

      {result?.truncated && <p className="insp-hint">产物太多，只列出了最近的一批。</p>}

      {/* 整份清单凭什么算这个任务的：共享目录下它只是候选，这句不能省。 */}
      {result && artifacts.length > 0 && ARTIFACT_SCOPE_NOTE[result.scope] && (
        <p className="insp-hint artifacts__scope">{ARTIFACT_SCOPE_NOTE[result.scope]}</p>
      )}
    </div>
  );
}

/** 一份清单按类型分节铺开。确定的和拿不准的各用一份，翻页的那一串也各管各的。 */
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
  onOpenFile: OpenFile;
  notify: (message: string) => void;
}) {
  return groupArtifacts(artifacts).map((group) => {
    // 翻页的那一串按**这一组**给（图片跟图片翻、网页跟网页翻）：分组本来就是「同一类东西」
    // 的意思，跨组翻到一份 html 只会让人以为点错了。
    const reel = group.items.map((item) => item.path);
    const thumbs = THUMB_KINDS.has(group.key as TaskArtifact["kind"]);
    return (
      <section key={group.key} className="artifacts__group" aria-label={group.label}>
        <InspSec count={group.items.length}>{group.label}</InspSec>
        {thumbs ? (
          <div className="artifacts__thumbs">
            {group.items.map((artifact) => (
              <ThumbItem key={artifact.path} taskId={taskId} artifact={artifact} reel={reel} active={artifact.path === activePath} onOpenFile={onOpenFile} notify={notify} />
            ))}
          </div>
        ) : (
          <ul className="artifacts__list">
            {group.items.map((artifact) => (
              <LineItem key={artifact.path} taskId={taskId} artifact={artifact} reel={reel} active={artifact.path === activePath} onOpenFile={onOpenFile} notify={notify} />
            ))}
          </ul>
        )}
      </section>
    );
  });
}
