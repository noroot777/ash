export type TerminalReservation = {
  replacedSessionIds: ReadonlySet<string>;
  started: boolean;
};

type CapacitySession = { id: string; projectId: string; commandId: string | null };

export class TerminalCapacity<Session extends CapacitySession> {
  private readonly reservations = new Set<TerminalReservation>();

  constructor(
    private readonly limit: number,
    private readonly sessions: () => Iterable<Session>,
    private readonly alive: (session: Session) => boolean,
    private readonly retained: (session: Session) => boolean = () => false,
  ) {}

  hasSlot(projectId: string, commandId: string | null, replaceLive = false): boolean {
    return this.occupied(this.replacedSessions(projectId, commandId, replaceLive)) < this.limit;
  }

  reserve(projectId: string, commandId: string | null, replaceLive = false): TerminalReservation {
    const replacedSessionIds = this.replacedSessions(projectId, commandId, replaceLive);
    if (this.occupied(replacedSessionIds) >= this.limit) throw new Error("终端会话数量已达上限");
    const reservation = { replacedSessionIds, started: false };
    this.reservations.add(reservation);
    return reservation;
  }

  begin(reservation: TerminalReservation): void {
    if (!this.reservations.has(reservation) || reservation.started) throw new Error("终端容量预留已失效");
    reservation.started = true;
  }

  validate(reservation: TerminalReservation): void {
    if (!this.reservations.has(reservation) || !reservation.started) throw new Error("终端容量预留已失效");
    if (this.occupied(new Set()) > this.limit) throw new Error("终端会话数量已达上限");
  }

  release(reservation: TerminalReservation): void {
    this.reservations.delete(reservation);
  }

  private replacedSessions(projectId: string, commandId: string | null, replaceLive: boolean): Set<string> {
    const replaced = new Set<string>();
    if (commandId === null) return replaced;
    for (const session of this.sessions()) {
      if (session.projectId === projectId && session.commandId === commandId && !this.retained(session) && (replaceLive || !this.alive(session))) {
        replaced.add(session.id);
      }
    }
    return replaced;
  }

  /**
   * 这条会话是**纯历史记录**吗 —— `retained` 为真(没能确认停净)而名下什么都不剩。
   *
   * 「保留」和「占用」必须分开(第 2 轮审查必须修 1)。保留是为了让「我停过、但没能确认
   * 停净」这句话在刷新之后还看得见(根 AGENTS.md 的硬要求);可这种记录的 pids 和端口都是
   * 空的,除了那句话之外**不提供任何把手** —— 拦着它既停不掉一个进程、也保不住任何证据,
   * 却会把活 pty 的预算一个一个吃光。实测后果:同一个服务启停 16 次之后整个 ash 开不出
   * 终端(换项目、新建普通终端一样报上限),闲置回收一条都收不走,restart 更会卡在
   * 「旧的已经如期停了、新的起不来」—— 因为 `reserve` 按「旧会话会被替换」放行,停完它变成
   * 保留记录、不再可替换,`validate` 这才抛上限,而服务已经停了。
   *
   * **名下还有活物的保留记录照旧算占用**:那种记录是触达残留进程的唯一把手,它确实在消耗
   * 真实资源。所以判据是「保留 **且** 不活」,不是「保留」。
   */
  private pureHistory(session: Session): boolean {
    return this.retained(session) && !this.alive(session);
  }

  private occupied(replaced: ReadonlySet<string>): number {
    // 容量是为了限住真实 pty,不是为了限住一句话:纯历史记录整条不进这笔账 —— 既不计数,
    // 也不需要被「替换」抵掉(它压根没占位置)。
    const sessions = [...this.sessions()].filter((session) => !this.pureHistory(session));
    const covered = new Set<string>();
    const replacementGroups = [replaced, ...Array.from(this.reservations, (reservation) => reservation.replacedSessionIds)];
    for (const replacementIds of replacementGroups) {
      const sessionId = [...replacementIds].find((candidate) => sessions.some((session) => session.id === candidate && !this.retained(session)));
      if (sessionId !== undefined) covered.add(sessionId);
    }
    let occupied = this.reservations.size;
    for (const session of sessions) {
      if (!covered.has(session.id)) occupied++;
    }
    return occupied;
  }
}
