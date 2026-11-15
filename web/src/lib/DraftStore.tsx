import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import type { UploadAttachment, UploadingFile } from "../task-detail/Attachments.tsx";
import type { ScreenshotDraft } from "../page-annotation/model.ts";
import type { ReuseMark } from "../task-detail/withdrawDraft.ts";
import type { ReplyCall } from "../task-detail/replyCall.ts";
import type { Task } from "@ash/shared";
import type { ComposerExecutorConfig } from "../composer/executorOverrides.ts";

// 「还没发出去的那份东西」统一放这里：对话框的回复草稿、主工作区新建任务框里的草稿，
// 都是同一件事 —— 组件卸载（切任务、去设置、开聊天）不该把用户敲的字和粘的图弄丢。
// 存活范围是**这一次会话**（provider 挂在 App 上），刷新页面即清空，跟对话框一致。
// Draft 对象是**不可变**的:updateDraft 对任何实际变化都返回新对象、没变化保留原
// 对象引用(见下方判等)。对象引用因此可以当「这份草稿的版本标识」用——异步收尾
// 拿提交时刻的引用对比此刻的,引用相同 ⇔ 期间任何字段(正文、附件、在途上传、
// 回链、截图)都没动过,改过又改回也算动过。settleSubmission 靠这一点和提交戳做原子的
// 归属裁决。
export type Draft = {
  screenshot?: ScreenshotDraft | null;
  text: string;
  attachments: UploadAttachment[];
  // 在途上传也留在草稿里：切走再切回来，那张图该还在传、进度条该接着走。
  pendingUploads: UploadingFile[];
  // 新建任务框专用：正文来自随手记时，创建成功后要把任务 id 回写给这几条随手记。
  // 它跟着草稿一起活，所以「转任务 → 中途去看别的 → 回来再创建」的回链不会断。
  noteIds: string[];
  // 回复框的发送方式(定时 / 等任务完成)。它决定这份正文**什么时候**发,跟正文同生共死:
  // 切走再回来正文还在、条件却变回立即发送,按下去就提前发了(第 1 轮审查实测)。
  // 缺省 / null = 立即发送。
  later?: LaterDraft | null;
  // 正文的版本：正文每变一次就换一个（updateDraft 自动换），「改了再发」认领时也换。发送结算
  // 只在版本仍是提交那一刻的才清正文——字面相等不等于还是那一份：清掉再放回同一句，字一样，
  // 却是用户又选了一次（「改了再发」审查第 3 轮实测，迟到的确认把它清了）。
  textVersion?: number;
  // 上一次「改了再发」放回的是哪一条、放完草稿是哪个版本；判连点用（见 withdrawDraft.ts 的
  // reuseDraft）。跟草稿放在同一份状态里，判定与更新一次完成。
  reuse?: ReuseMark | null;
  // 新建任务框专用：框里 `@` 叫着的人、叫来做什么（问一句 / 讨论，composer/ComposerCall.tsx）。跟正文同生共死：
  // 切走再回来正文还在、叫的人却没了，按下去就成了一条普通任务。
  call?: ReplyCall | null;
  // 新建任务框专用：这条任务自己的执行器（胶囊上那一套）。跟叫的人一起存：叫谁算不算「叫自己」由它定，
  // 重开面板时它要是退回默认值，叫来的人会被当成叫自己删掉。没选过 = 用默认的那个。
  executor?: ComposerExecutorConfig | null;
  // 新建任务框专用：任务已经建好、第一回合（问一句 / 讨论）还没被服务端接下的那一条，连同没接下的原因。
  // 再按一次只对它重发这一下，不再建一条（composer/settleCreatedTask.ts）。
  created?: ComposerCreated | null;
  // 新建任务框专用：最近一次提交盖的戳（stampSubmission）。异步结果回来时凭它认这份草稿还是不是自己那一份：
  // 中途清空过、换成了另一件事（含随手记转任务并进来一份，adopt），戳就没了或换了，迟到的结果——成功也好失败也好——
  // 都不许动它的任何部分：正文、附件、叫的人、待重发的那条（settleSubmission 是唯一的口子）。
  submission?: string | null;
};

/** 已建好、第一回合还没送达的那条任务。 */
export type ComposerCreated = { task: Task; error: string };

let textVersions = 0;
/** 一个新的正文版本。只比相等，跳号无所谓。 */
export const nextTextVersion = () => (textVersions += 1);

/** 选了「稍后」时的那份设置。时间过期、等的任务没了也原样留着,由用户改,不静默退回立即发。 */
export type LaterDraft = { kind: "timed" | "after"; at: string; afterTaskId: string };

type DraftContextValue = {
  drafts: Record<string, Draft>;
  updateDraft: (key: string, update: (current: Draft) => Draft) => void;
  readDraft: (key: string) => Draft;
  trackSend: (key: string, run: Promise<unknown>) => void;
  afterSend: (key: string) => Promise<void>;
};

const EMPTY_DRAFT: Draft = { text: "", attachments: [], pendingUploads: [], noteIds: [] };
const DraftContext = createContext<DraftContextValue | null>(null);

/** 一条草稿的存放位置。任务回复按任务分，新建任务框按项目分 —— 两边不会互相盖。 */
export const replyDraftKey = (taskId: string) => `reply:${taskId}`;
export const composerDraftKey = (projectId: string) => `composer:${projectId}`;

export function DraftProvider({ children }: { children: ReactNode }) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  // 异步提交的收尾(发送/创建完成)读「此刻」的草稿,不能用发起那一刻的闭包值:
  // 组件可能早已卸载、草稿可能已被后来打开的面板改写。ref 是权威的那一份:每次改动当场算好
  // 写进 ref 再交给 React 渲染,所以 readDraft 和「判定 + 改写」读到的永远是最新的,不会落在
  // setState 与 effect 同步之间的那个窗口里(那里读到旧值,归属就会判错)。
  const draftsRef = useRef(drafts);
  const readDraft = useCallback((key: string) => draftsRef.current[key] ?? EMPTY_DRAFT, []);
  const updateDraft = useCallback((key: string, update: (current: Draft) => Draft) => {
    const apply = (current: Record<string, Draft>) => {
      const previous = current[key] ?? EMPTY_DRAFT;
      let next = update(previous);
      if (next.text !== previous.text && next.textVersion === previous.textVersion) next = { ...next, textVersion: nextTextVersion() };
      if (!next.text && next.attachments.length === 0 && next.pendingUploads.length === 0
        && next.noteIds.length === 0 && !next.screenshot && !next.later && !next.call && !next.created && !next.executor) {
        if (!(key in current)) return current;
        const { [key]: _removed, ...remaining } = current;
        return remaining;
      }
      if (next.text === previous.text
        && next.attachments === previous.attachments
        && next.pendingUploads === previous.pendingUploads
        && next.noteIds === previous.noteIds
        && next.screenshot === previous.screenshot
        && next.later === previous.later
        && next.call === previous.call
        && next.created === previous.created
        && next.executor === previous.executor
        && next.submission === previous.submission
        && next.textVersion === previous.textVersion
        && next.reuse === previous.reuse) return current;
      return { ...current, [key]: next };
    };
    const next = apply(draftsRef.current);
    if (next === draftsRef.current) return;
    draftsRef.current = next;
    setDrafts(next);
  }, []);
  // 正在飞的发送。它们结算时按「发送那一刻的那一份」摘草稿（clearSentDraft /
  // dropSentAttachments），所以对话框之外往草稿里放东西（撤回、会话里「改了再发」）排在它们
  // 后面：先清后并。这只是辅助——附件归属靠选择记号兜底，顺序乱了也摘不错。
  // 每份草稿记**一组**而不是一个：发送中再按一次发送键，那一次早退的调用不能把真正还在飞的
  // 那次顶掉（「改了再发」第 2 轮审查实测，顶掉后等待形同虚设）。
  const sends = useRef(new Map<string, Set<Promise<unknown>>>());
  const trackSend = useCallback((key: string, run: Promise<unknown>) => {
    const runs = sends.current.get(key) ?? new Set<Promise<unknown>>();
    sends.current.set(key, runs);
    runs.add(run);
    const done = () => {
      runs.delete(run);
      if (!runs.size && sends.current.get(key) === runs) sends.current.delete(key);
    };
    run.then(done, done);
  }, []);
  const afterSend = useCallback(async (key: string) => {
    for (let runs = sends.current.get(key); runs?.size; runs = sends.current.get(key)) await Promise.allSettled([...runs]);
  }, []);
  const value = useMemo(() => ({ drafts, updateDraft, readDraft, trackSend, afterSend }), [drafts, updateDraft, readDraft, trackSend, afterSend]);
  return <DraftContext.Provider value={value}>{children}</DraftContext.Provider>;
}

export type DraftHandle = {
  screenshot: ScreenshotDraft | null;
  setScreenshot: Dispatch<SetStateAction<ScreenshotDraft | null>>;
  text: string;
  attachments: UploadAttachment[];
  pendingUploads: UploadingFile[];
  noteIds: string[];
  setText: Dispatch<SetStateAction<string>>;
  setAttachments: Dispatch<SetStateAction<UploadAttachment[]>>;
  setPendingUploads: Dispatch<SetStateAction<UploadingFile[]>>;
  setNoteIds: Dispatch<SetStateAction<string[]>>;
  later: LaterDraft | null;
  setLater: Dispatch<SetStateAction<LaterDraft | null>>;
  call: ReplyCall | null;
  setCall: Dispatch<SetStateAction<ReplyCall | null>>;
  executor: ComposerExecutorConfig | null;
  setExecutor: Dispatch<SetStateAction<ComposerExecutorConfig | null>>;
  created: ComposerCreated | null;
  /** 给这份草稿盖上这次提交的戳，返回盖完的那一份（提交那一刻的归属标识，见 settleSubmission）。 */
  stampSubmission: (token: string) => Draft;
  /**
   * 往新建框的草稿里并进别处带来的另一份内容（随手记转任务）。并进来就是另一件事，跟提交有关的旧状态在同一次
   * 更新里一起断开：撕掉在途那次提交的戳（迟到的成功、失败都不再认这份草稿），解开「已建好、待重发」的那条
   * （新内容再发是新建一条，不发进上一条任务；那条留在待办里）。叫的人是用户眼前的安排，留着。
   */
  adopt: (merge: (current: Draft) => Draft) => void;
  /**
   * 一次提交的结果回来了，由它来动草稿——成功清空（"clear"）、第一回合没送达挂上待重发的那条（{ created }）
   * 都只走这一个口子。草稿还盖着这次的戳才认；给了 unchangedSince 还要求自那一刻起**完全没动过**（对象引用
   * 相同：发起的面板已经卸载时，任何字段变化——附件增删、在途上传、正文改过又改回——都让旧提交失去资格，
   * 第 10 轮审查）。判定与改写在 Store 更新处一次完成；返回认没认。清空时掐掉此刻清单里的在途上传。
   */
  settleSubmission: (token: string, outcome: "clear" | { created: ComposerCreated }, unchangedSince?: Draft) => boolean;
  /** 此刻这份草稿的不可变对象(引用即版本标识,提交时捕获、收尾时对比归属)。 */
  value: Draft;
  /** 整份丢掉（发送/创建成功，或用户自己按了「清空」）。 */
  clear: () => void;
  /**
   * 一次改好几个字段（正文 + 附件），拿到的是此刻 Store 里的那一份。判断要同时看几个字段的
   * 操作（「改了再发」判连点）用它，免得各自的 setter 在不同时刻读到不同版本。
   */
  update: (next: (current: Draft) => Draft) => void;
  /** 登记一次正在飞的发送（它结算时会摘掉自己那一份）。 */
  trackSend: (run: Promise<unknown>) => void;
  /** 等这份草稿上在飞的发送都结算完；外部往草稿里放东西前先等它。 */
  afterSend: () => Promise<void>;
};

export function useDraft(key: string): DraftHandle {
  const context = useContext(DraftContext);
  if (!context) throw new Error("useDraft must be used inside DraftProvider");
  const draft = context.drafts[key] ?? EMPTY_DRAFT;
  const { updateDraft, readDraft, trackSend: track, afterSend: settle } = context;
  const setScreenshot = useCallback<Dispatch<SetStateAction<ScreenshotDraft | null>>>((next) => {
    updateDraft(key, (current) => ({
      ...current,
      screenshot: typeof next === "function" ? next(current.screenshot ?? null) : next,
    }));
  }, [key, updateDraft]);
  const setText = useCallback<Dispatch<SetStateAction<string>>>((next) => {
    updateDraft(key, (current) => ({
      ...current,
      text: typeof next === "function" ? next(current.text) : next,
    }));
  }, [key, updateDraft]);
  const setAttachments = useCallback<Dispatch<SetStateAction<UploadAttachment[]>>>((next) => {
    updateDraft(key, (current) => ({
      ...current,
      attachments: typeof next === "function" ? next(current.attachments) : next,
    }));
  }, [key, updateDraft]);
  const setPendingUploads = useCallback<Dispatch<SetStateAction<UploadingFile[]>>>((next) => {
    updateDraft(key, (current) => ({
      ...current,
      pendingUploads: typeof next === "function" ? next(current.pendingUploads) : next,
    }));
  }, [key, updateDraft]);
  const setNoteIds = useCallback<Dispatch<SetStateAction<string[]>>>((next) => {
    updateDraft(key, (current) => ({
      ...current,
      noteIds: typeof next === "function" ? next(current.noteIds) : next,
    }));
  }, [key, updateDraft]);
  const setLater = useCallback<Dispatch<SetStateAction<LaterDraft | null>>>((next) => {
    updateDraft(key, (current) => ({
      ...current,
      later: typeof next === "function" ? next(current.later ?? null) : next,
    }));
  }, [key, updateDraft]);
  const setCall = useCallback<Dispatch<SetStateAction<ReplyCall | null>>>((next) => {
    updateDraft(key, (current) => ({
      ...current,
      call: typeof next === "function" ? next(current.call ?? null) : next,
    }));
  }, [key, updateDraft]);
  const setExecutor = useCallback<Dispatch<SetStateAction<ComposerExecutorConfig | null>>>((next) => {
    updateDraft(key, (current) => ({
      ...current,
      executor: typeof next === "function" ? next(current.executor ?? null) : next,
    }));
  }, [key, updateDraft]);
  const stampSubmission = useCallback((token: string) => {
    updateDraft(key, (current) => ({ ...current, submission: token }));
    return readDraft(key);
  }, [key, readDraft, updateDraft]);
  const adopt = useCallback((merge: (current: Draft) => Draft) => {
    updateDraft(key, (current) => ({ ...merge(current), submission: null, created: null }));
  }, [key, updateDraft]);
  const settleSubmission = useCallback((token: string, outcome: "clear" | { created: ComposerCreated }, unchangedSince?: Draft) => {
    let owned = false;
    updateDraft(key, (current) => {
      if (current.submission !== token || (unchangedSince && current !== unchangedSince)) return current;
      owned = true;
      if (outcome !== "clear") return { ...current, created: outcome.created };
      for (const pending of current.pendingUploads) pending.abort();
      return EMPTY_DRAFT;
    });
    return owned;
  }, [key, updateDraft]);
  // 在途上传一并掐掉：清空之后那几张图再传完也没有地方落，进度条却还挂在别处跑。
  // 按 Store 此刻的在途清单掐,不是 handle 创建那一刻的——clear 常在异步收尾里被调。
  const clear = useCallback(() => {
    for (const pending of readDraft(key).pendingUploads) pending.abort();
    updateDraft(key, () => EMPTY_DRAFT);
  }, [key, readDraft, updateDraft]);
  const update = useCallback((next: (current: Draft) => Draft) => updateDraft(key, next), [key, updateDraft]);
  const trackSend = useCallback((run: Promise<unknown>) => track(key, run), [key, track]);
  const afterSend = useCallback(() => settle(key), [key, settle]);
  return {
    screenshot: draft.screenshot ?? null,
    setScreenshot,
    text: draft.text,
    attachments: draft.attachments,
    pendingUploads: draft.pendingUploads,
    noteIds: draft.noteIds,
    setText,
    setAttachments,
    setPendingUploads,
    setNoteIds,
    later: draft.later ?? null,
    setLater,
    call: draft.call ?? null,
    setCall,
    executor: draft.executor ?? null,
    setExecutor,
    created: draft.created ?? null,
    stampSubmission,
    adopt,
    settleSubmission,
    value: draft,
    clear,
    update,
    trackSend,
    afterSend,
  };
}

export function useTaskReplyDraft(taskId: string): DraftHandle {
  return useDraft(replyDraftKey(taskId));
}
