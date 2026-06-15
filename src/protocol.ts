// typrun-ws 메시지 프로토콜 (네이티브 ws, JSON `{ t, ... }`)
// 설계서 §3.4 기준. 풀 위치는 안 보냄 — 공유 시드 + 이벤트만 중계.

export type Mode = '2p' | '3p';

export interface PlayerInfo {
  userSeq: number;
  nickname: string;
  profileImage?: string | null;
  joinOrder: number; // 0,1,2
}

export interface MatchResult {
  userSeq: number;
  rankInMatch: number;
  finalScore: number;
  result: 'win' | 'loss' | 'draw';
}

// ── Client → Server ──────────────────────────────────────────────
export type ClientMsg =
  | { t: 'ping'; c: number }
  | { t: 'queue:join'; categorySeq: number; mode: Mode; nickname?: string }
  | { t: 'queue:leave' }
  | { t: 'match:ready'; matchId: string; cid?: number }
  | { t: 'word:clear'; matchId: string; spawnIndex: number; typed: string; comboAfter: number; elapsedMs: number; cid?: number }
  | { t: 'word:typing'; matchId: string; spawnIndex: number; len: number } // 입력 진행(실시간 상대 표시용)
  | { t: 'word:miss'; matchId: string; spawnIndex: number; hp: number }
  | { t: 'state:update'; matchId: string; score: number; combo: number; hp: number } // 상대 미러뷰 동기화(스로틀)
  | { t: 'item:used'; matchId: string; effect: string } // 공격형 아이템 1개를 상대에게(2인 자동조준)
  | { t: 'effect:sync'; matchId: string; effect: string } // 공유필드: 낙하속도/정지 효과를 양쪽 동기화(거북이/멈춤/가속)
  | { t: 'match:finish'; matchId: string; clientScore: number; maxCombo: number; correct: number; miss: number }
  | { t: 'match:resync'; matchId: string };

// ── Server → Client ──────────────────────────────────────────────
export type ServerMsg =
  | { t: 'pong'; c: number; srvT: number }
  | { t: 'queue:status'; have: number; need: number }
  | { t: 'queue:slow' }
  | { t: 'queue:lonely'; suggest: 'retry' | '2p' }
  | { t: 'match:found'; matchId: string; mode: Mode; matchSeed: number; matchStartTs: number; players: PlayerInfo[]; you: number }
  | { t: 'match:start'; matchId: string; serverTs: number }
  | { t: 'opponent:clear'; userSeq: number; spawnIndex: number; scoreDelta: number; totalScore: number; combo: number; isFirst: boolean; serverTs: number }
  | { t: 'clear:reject'; spawnIndex: number } // 선착 패배 — 낙관적 클리어 롤백하라(경쟁형: 단어 1개 선착)
  | { t: 'opponent:typing'; userSeq: number; spawnIndex: number; len: number } // 실시간 상대 입력 진행(소규모 방이라 OK)
  | { t: 'opponent:state'; userSeq: number; score: number; combo: number; hp: number }
  | { t: 'opponent:finished'; userSeq: number } // 상대가 먼저 끝남 → 즉시 마무리 신호(클라가 자기 게임도 종료)
  | { t: 'item:used'; userSeq: number; effect: string; targetSeq: number } // 공격=상대(자동조준), 버프=본인
  | { t: 'opponent:effect'; effect: string } // 상대가 발동한 동기화 효과(거북이/멈춤/가속) — 내 필드에도 적용
  | { t: 'match:over'; matchId: string; results: MatchResult[]; isRanked: boolean }
  | { t: 'match:cancelled'; matchId: string; reason: 'opponent_left' } // 카운트다운 중 상대 이탈 → 매치 취소
  | { t: 'error'; code: string; message: string };

export function needForMode(mode: Mode): number {
  return mode === '3p' ? 3 : 2;
}
