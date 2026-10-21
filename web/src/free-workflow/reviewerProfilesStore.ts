// 审查者配置在前端的单点：哪一份清单算数、什么时候重读、已经删掉的那位怎么保证回不来。
//
// 为什么要有这么个东西：审查者是一份**全局配置**，删除入口有两个（设置页、派审对话框），
// 每个入口都可能在另一个标签页、另一台机器上被按下。读侧（派审对话框）原来把「当前任务的
// 修订号变了」当成重读信号，那是不成立的：
//  · 删掉的那位**没有被当前任务预约**时，服务端只清自己的引用，不发这项任务的 task.review
//    （`server/src/reviewer-profiles.ts` 只遍历 selectedReviewerId 命中的任务，还会跳过
//    未 armed 和自动续轮的），当前任务的修订号一动不动 —— 于是对话框一直摆着一个已经不
//    存在的配置，点下去才报「所选审查者不存在」；
//  · 用户在对话框里**刚改选**的那位只是草稿，根本不在持久化预约里，更不可能靠「这项任务
//    的状态变了」推断出它受不受全局删除影响。
//
// 所以这一层的判据有三条，和 `lib/settingsSync.ts` 同一套思路：
//  · **失效信号不依赖当前任务**。重读由四件事触发：有人订阅（对话框打开）、本机写成功、
//    窗口重新拿到焦点（在另一个标签页删完切回来那一下）、以及订阅期间的定时轮询。
//  · **写拍定读**。一次读发出时的写代次和回来时不一致（这期间删/建/改成功过），这份应答
//    整个作废重读 —— 先发后到的 GET 会把刚删掉的那位又贴回清单。
//  · **已知删除不许倒退**。删成功就记一条墓碑，之后任何来源（迟到的 GET、某个闭包里捕获
//    的旧清单）给出的清单都先过一遍墓碑过滤。只有「写代次比墓碑更新的读」才能拆掉它 ——
//    否则同一个 id 被两条路径各写一次，顺序由网络决定。
import type { ReviewerProfile } from "@ash/shared";
import { api } from "../lib/api.ts";

/** 订阅期间的轮询间隔。只在有人订阅（= 某个对话框开着）时跑，关掉就停。 */
const POLL_MS = 4_000;

let cache: ReviewerProfile[] | null = null;
/** 写代次：每成功写一次（删 / 建 / 改）+1。读按它判自己是不是旧世界的应答。 */
let writeGen = 0;
/** 墓碑：本机已确认删除的 id → 删它时的写代次。 */
const tombstones = new Map<string, number>();
/**
 * 变化的来源。读侧要用它区分两件事：**本机刚按下的那次写**（它自己会给提示，订阅端
 * 只需静悄悄把清单和选中项对齐）和**别处发生的变化**（用户不知情，必须说一句）。
 */
export type ReviewerListChange = "local" | "remote";

const listeners = new Set<(source: ReviewerListChange) => void>();
let inflight: Promise<ReviewerProfile[]> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function emit(source: ReviewerListChange) {
  for (const listener of [...listeners]) listener(source);
}

/**
 * 过墓碑。`gen` 是这份清单的来源对应的写代次：比某条墓碑更新的读才有资格宣布
 * 「这个 id 又存在了」（同一个 id 不会被服务端复用，所以这种情况实际只出现在
 * 「墓碑是本机写的、清单是更晚的权威读」这一种组合上）。
 */
function applyTombstones(list: ReviewerProfile[], gen: number): ReviewerProfile[] {
  if (!tombstones.size) return list;
  for (const [deletedId, deletedGen] of tombstones) {
    if (gen > deletedGen && list.some((item) => item.id === deletedId)) tombstones.delete(deletedId);
  }
  return list.filter((item) => !tombstones.has(item.id));
}

/** 清单没变就不往外吱声：订阅端每收到一次就重渲染一次，4 秒一拍的空转没必要。 */
function same(current: ReviewerProfile[] | null, next: ReviewerProfile[]): boolean {
  if (!current || current.length !== next.length) return false;
  // updatedAt 跟着每一次 PATCH 走，当版本号用。
  return current.every((item, index) => item.id === next[index].id && item.updatedAt === next[index].updatedAt);
}

function commit(list: ReviewerProfile[], gen: number) {
  const next = applyTombstones(list, gen);
  const changed = !same(cache, next);
  cache = next;
  if (changed) emit("remote");
}

/**
 * 读权威清单。写代次在应答回来时变了就整份丢掉、再读一次；同时只允许一条在飞，
 * 多个调用点（初始化、轮询、焦点、提交前校验）共用同一条。
 */
function read(): Promise<ReviewerProfile[]> {
  if (inflight) return inflight;
  const run = (): Promise<ReviewerProfile[]> => {
    const gen = writeGen;
    return api.reviewerProfiles().then((list) => {
      if (gen !== writeGen) return run();
      commit(list, gen);
      return cache!;
    });
  };
  inflight = run().finally(() => { inflight = null; });
  return inflight;
}

/** 本机写成功之后：作废在飞的读，并把结果直接落进缓存。 */
function afterWrite(mutate: (current: ReviewerProfile[]) => ReviewerProfile[]) {
  writeGen += 1;
  cache = mutate(cache ?? []);
  emit("local");
}

function startPolling() {
  if (timer || typeof window === "undefined") return;
  timer = setInterval(() => { void read().catch(() => {}); }, POLL_MS);
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onFocus);
}

function stopPolling() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  window.removeEventListener("focus", onFocus);
  document.removeEventListener("visibilitychange", onFocus);
}

function onFocus() {
  if (document.visibilityState === "hidden") return;
  void read().catch(() => {});
}

export const reviewerProfilesStore = {
  /** 当前缓存；null = 这个会话还没读过一次。 */
  current: (): ReviewerProfile[] | null => cache,

  /**
   * 订阅清单变化。订阅期间这一层自己负责保持新鲜（轮询 + 焦点），所以读侧**不需要**
   * 再找一个「任务状态变了」之类的信号来推断全局配置变没变。
   */
  subscribe: (listener: (source: ReviewerListChange) => void): (() => void) => {
    listeners.add(listener);
    startPolling();
    return () => {
      listeners.delete(listener);
      if (!listeners.size) stopPolling();
    };
  },

  /** 立刻读一次权威清单（对话框初始化、提交前校验都走它）。 */
  read,

  /** 删一位。服务端成功后才落墓碑：失败的删除不许影响任何读。 */
  remove: async (profileId: string): Promise<void> => {
    await api.deleteReviewerProfile(profileId);
    tombstones.set(profileId, writeGen + 1);
    afterWrite((current) => current.filter((item) => item.id !== profileId));
  },

  create: async (
    payload: Parameters<typeof api.createReviewerProfile>[0],
  ): Promise<ReviewerProfile> => {
    const created = await api.createReviewerProfile(payload);
    afterWrite((current) => [created, ...current.filter((item) => item.id !== created.id)]);
    return created;
  },

  update: async (
    profileId: string,
    payload: Parameters<typeof api.patchReviewerProfile>[1],
  ): Promise<ReviewerProfile> => {
    const updated = await api.patchReviewerProfile(profileId, payload);
    afterWrite((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    return updated;
  },
};
