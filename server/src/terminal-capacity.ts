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
  }

  release(reservation: TerminalReservation): void {
    this.reservations.delete(reservation);
  }

  private replacedSessions(projectId: string, commandId: string | null, replaceLive: boolean): Set<string> {
    const replaced = new Set<string>();
    if (commandId === null) return replaced;
    for (const session of this.sessions()) {
      if (session.projectId === projectId && session.commandId === commandId && (replaceLive || !this.alive(session))) {
        replaced.add(session.id);
      }
    }
    return replaced;
  }

  private occupied(replaced: ReadonlySet<string>): number {
    const covered = new Set(replaced);
    for (const reservation of this.reservations) {
      for (const sessionId of reservation.replacedSessionIds) covered.add(sessionId);
    }
    let occupied = this.reservations.size;
    for (const session of this.sessions()) {
      if (!covered.has(session.id)) occupied++;
    }
    return occupied;
  }
}
