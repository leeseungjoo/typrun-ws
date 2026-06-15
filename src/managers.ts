import { randomBytes } from 'crypto';
import type { Mode, PlayerInfo, MatchResult } from './protocol';
import { needForMode } from './protocol';

// ── 매칭 큐 (인메모리, `${categorySeq}:${mode}` FIFO) ────────────────
export interface QueueEntry {
  userSeq: number;
  nickname: string;
  profileImage?: string | null;
  enqueuedAt: number;
}

export class QueueManager {
  private queues = new Map<string, QueueEntry[]>();
  private key(categorySeq: number, mode: Mode): string {
    return `${categorySeq}:${mode}`;
  }

  join(categorySeq: number, mode: Mode, entry: QueueEntry): void {
    const k = this.key(categorySeq, mode);
    const list = this.queues.get(k) ?? [];
    if (!list.some((e) => e.userSeq === entry.userSeq)) list.push(entry);
    this.queues.set(k, list);
  }

  leave(userSeq: number): void {
    for (const list of this.queues.values()) {
      const i = list.findIndex((e) => e.userSeq === userSeq);
      if (i >= 0) list.splice(i, 1);
    }
  }

  /** 인원 충족 시 매칭 그룹을 큐에서 꺼내 반환, 아니면 null. */
  tryMatch(categorySeq: number, mode: Mode): QueueEntry[] | null {
    const list = this.queues.get(this.key(categorySeq, mode)) ?? [];
    const need = needForMode(mode);
    if (list.length < need) return null;
    return list.splice(0, need);
  }

  waitingCount(categorySeq: number): number {
    let n = 0;
    for (const [k, list] of this.queues) {
      if (k.startsWith(`${categorySeq}:`)) n += list.length;
    }
    return n;
  }

  /** 특정 모드만의 대기 인원 (queue:status 의 have 는 모드별이어야 정확). */
  waitingCountForMode(categorySeq: number, mode: Mode): number {
    return this.queues.get(this.key(categorySeq, mode))?.length ?? 0;
  }
}

// 승부 인정 최소 점수 — 1등 점수가 이 미만이면 무효판(전원 draw). 클라 화면에도 동일 표기(기획 2026-06-15).
export const WIN_THRESHOLD = 500;

// ── 룸/매치 FSM (인메모리) ──────────────────────────────────────────
export type MatchStatus = 'countdown' | 'playing' | 'done';

export interface FinishStat {
  score: number;
  maxCombo: number;
  correct: number;
  miss: number;
  abandoned: boolean; // 이탈(disconnect/grace 만료)로 종료된 경우
}

export interface MatchState {
  matchId: string;
  categorySeq: number;
  mode: Mode;
  matchSeed: number; // uint32 공유 시드
  matchStartTs: number; // t=0 절대시각(서버시계)
  players: PlayerInfo[];
  status: MatchStatus;
  ready: Set<number>;
  finishes: Map<number, FinishStat>; // userSeq → 종료 통계
  finalized: boolean; // match:over 1회 보장
}

export class RoomManager {
  private rooms = new Map<string, MatchState>();
  constructor(private readonly countdownMs: number) {}

  create(categorySeq: number, mode: Mode, players: PlayerInfo[]): MatchState {
    const state: MatchState = {
      matchId: randomBytes(8).toString('hex'),
      categorySeq,
      mode,
      matchSeed: randomBytes(4).readUInt32BE(0) >>> 0,
      matchStartTs: Date.now() + this.countdownMs,
      players,
      status: 'countdown',
      ready: new Set<number>(),
      finishes: new Map<number, FinishStat>(),
      finalized: false,
    };
    this.rooms.set(state.matchId, state);
    return state;
  }

  get(matchId: string): MatchState | undefined {
    return this.rooms.get(matchId);
  }

  /** 종료 통계 기록(룸 멤버만, 1회). */
  recordFinish(matchId: string, userSeq: number, stat: FinishStat): void {
    const r = this.rooms.get(matchId);
    if (!r || r.finalized) return;
    if (!r.players.some((p) => p.userSeq === userSeq)) return;
    if (!r.finishes.has(userSeq)) r.finishes.set(userSeq, stat);
  }

  allFinished(matchId: string): boolean {
    const r = this.rooms.get(matchId);
    return !!r && r.finishes.size >= r.players.length;
  }

  /** 미제출 플레이어를 이탈(score 0)로 채워 결과 순위를 만든다. */
  buildResults(matchId: string): MatchResult[] {
    const r = this.rooms.get(matchId);
    if (!r) return [];
    const scored = r.players.map((p) => ({
      userSeq: p.userSeq,
      finalScore: r.finishes.get(p.userSeq)?.score ?? 0,
    }));
    const maxScore = Math.max(...scored.map((s) => s.finalScore));
    const topCount = scored.filter((s) => s.finalScore === maxScore).length;
    const sorted = [...scored].sort((a, b) => b.finalScore - a.finalScore);
    const rankOf = new Map(sorted.map((s, i) => [s.userSeq, i + 1]));
    // 1등 점수가 기준 미만이면 무효판 — 전원 draw(승부 불성립).
    const decisive = maxScore >= WIN_THRESHOLD;
    return scored.map((s) => ({
      userSeq: s.userSeq,
      rankInMatch: rankOf.get(s.userSeq) ?? r.players.length,
      finalScore: s.finalScore,
      result: !decisive
        ? 'draw'
        : s.finalScore === maxScore
        ? topCount > 1
          ? 'draw'
          : 'win'
        : 'loss',
    }));
  }

  markFinalized(matchId: string): void {
    const r = this.rooms.get(matchId);
    if (r) r.finalized = true;
  }

  finish(matchId: string): void {
    const r = this.rooms.get(matchId);
    if (r) r.status = 'done';
    this.rooms.delete(matchId);
  }

  playingCount(categorySeq: number): number {
    let n = 0;
    for (const r of this.rooms.values()) {
      if (r.categorySeq === categorySeq && r.status !== 'done') n += r.players.length;
    }
    return n;
  }
}

// ── 접속자 카운터 (게임중/대기중) ───────────────────────────────────
export class CounterService {
  constructor(
    private readonly queue: QueueManager,
    private readonly rooms: RoomManager,
  ) {}

  counts(categorySeq: number): { waiting: number; playing: number } {
    return {
      waiting: this.queue.waitingCount(categorySeq),
      playing: this.rooms.playingCount(categorySeq),
    };
  }
}
