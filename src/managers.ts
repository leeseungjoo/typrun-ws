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

// 승부 인정 최소 점수 — 1등 점수가 이 미만이면 무효판(전원 draw). 클라 화면에도 동일 표기(수정요청4 2026-06-15: 200).
export const WIN_THRESHOLD = 200;

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

// ── 친구 초대 대결: 사설 방 (인메모리, 코드로 입장) ────────────────────
// 호스트가 방을 만들면 짧은 코드를 받고, 코드 링크로 들어온 친구(비회원 포함)와 1:1 매치로 승격된다.
// 헷갈리는 0/O/1/I/L 제외 알파벳 — 구두로도 공유 가능.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;
const ROOM_TTL_MS = 30 * 60 * 1000; // 30분 지난 미사용 방은 청소

function genCode(): string {
  const bytes = randomBytes(CODE_LEN);
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export interface RoomMember {
  userSeq: number;
  nickname: string;
  profileImage?: string | null;
}

export interface PendingRoom {
  code: string;
  categorySeq: number;
  mode: Mode;
  hostSeq: number;
  members: RoomMember[]; // [0]=호스트
  createdAt: number;
}

export type JoinResult =
  | { ok: true; room: PendingRoom; ready: boolean } // ready=인원 충족(승격 가능)
  | { ok: false; reason: 'not_found' | 'full' };

export class PrivateRoomManager {
  private byCode = new Map<string, PendingRoom>();
  private codeByHost = new Map<number, string>(); // 호스트 재연결 멱등성(같은 호스트=같은 코드)

  /** 호스트가 방 생성. 같은 호스트가 이미 대기방을 가지면 그 방을 반환(재연결 멱등). */
  createOrGet(hostSeq: number, categorySeq: number, mode: Mode, host: RoomMember): PendingRoom {
    const existingCode = this.codeByHost.get(hostSeq);
    if (existingCode) {
      const r = this.byCode.get(existingCode);
      if (r) {
        r.members[0] = host; // 닉네임/프로필 최신화
        r.categorySeq = categorySeq;
        r.mode = mode;
        r.createdAt = Date.now();
        return r;
      }
      this.codeByHost.delete(hostSeq);
    }
    let code = genCode();
    while (this.byCode.has(code)) code = genCode();
    const room: PendingRoom = { code, categorySeq, mode, hostSeq, members: [host], createdAt: Date.now() };
    this.byCode.set(code, room);
    this.codeByHost.set(hostSeq, code);
    return room;
  }

  get(code: string): PendingRoom | undefined {
    return this.byCode.get(code.toUpperCase());
  }

  /** 코드로 입장. 이미 들어온 멤버면 멱등(재연결). 인원이 차면 ready=true. */
  join(code: string, member: RoomMember): JoinResult {
    const r = this.byCode.get(code.toUpperCase());
    if (!r) return { ok: false, reason: 'not_found' };
    const need = needForMode(r.mode);
    const already = r.members.some((m) => m.userSeq === member.userSeq);
    if (!already) {
      if (r.members.length >= need) return { ok: false, reason: 'full' };
      r.members.push(member);
    }
    return { ok: true, room: r, ready: r.members.length >= need };
  }

  /** 승격(매치 시작) 시 대기방을 큐에서 제거하고 반환. */
  take(code: string): PendingRoom | undefined {
    const r = this.byCode.get(code.toUpperCase());
    if (r) this.removeByCode(r.code);
    return r;
  }

  removeByCode(code: string): void {
    const r = this.byCode.get(code);
    if (!r) return;
    this.byCode.delete(r.code);
    if (this.codeByHost.get(r.hostSeq) === r.code) this.codeByHost.delete(r.hostSeq);
  }

  /** 호스트 이탈 → 그 호스트의 대기방 폐기. 폐기된 방의 (호스트 외) 잔여 멤버 seq 목록을 반환. */
  removeByHost(hostSeq: number): number[] {
    const code = this.codeByHost.get(hostSeq);
    if (!code) return [];
    const r = this.byCode.get(code);
    const others = r ? r.members.filter((m) => m.userSeq !== hostSeq).map((m) => m.userSeq) : [];
    this.removeByCode(code);
    return others;
  }

  /** 입장자(비호스트) 이탈 → 대기방에서만 제거(호스트는 계속 대기). 대기방이 영향받았으면 그 방을 반환. */
  removeMember(userSeq: number): PendingRoom | null {
    for (const r of this.byCode.values()) {
      if (r.hostSeq === userSeq) continue; // 호스트는 removeByHost 가 처리
      const i = r.members.findIndex((m) => m.userSeq === userSeq);
      if (i >= 0) {
        r.members.splice(i, 1);
        return r;
      }
    }
    return null;
  }

  /** 오래된 미사용 방 청소(주기 호출). */
  sweep(now: number): void {
    for (const r of [...this.byCode.values()]) {
      if (now - r.createdAt > ROOM_TTL_MS) this.removeByCode(r.code);
    }
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
