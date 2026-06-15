import { createServer, type IncomingMessage } from 'http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { jwtVerify } from 'jose';
import { QueueManager, RoomManager, CounterService } from './managers';
import type { ClientMsg, ServerMsg, Mode } from './protocol';
import { needForMode } from './protocol';

// ── 설정 ────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 3001);
// typrain-server(lib/userSession.ts)와 동일해야 같은 세션을 검증한다.
// 쿠키 typrun_session · HS256 · 페이로드 { uid: userSeq } · dev 폴백 시크릿 동일.
// 보안: 프로덕션에서 JWT_SECRET 미설정 시 알려진 dev 폴백으로 토큰 위조가 가능하므로 즉시 종료한다.
const JWT_SECRET =
  process.env.JWT_SECRET ||
  (process.env.NODE_ENV === 'production' ? '' : 'dev-insecure-secret-change-me-please-32');
if (!JWT_SECRET) {
  // eslint-disable-next-line no-console
  console.error('[typrun-ws] FATAL: 프로덕션에서는 JWT_SECRET 환경변수가 필수입니다.');
  process.exit(1);
}
const SESSION_COOKIE = process.env.SESSION_COOKIE || 'typrun_session';
// 상대가 들어오면 6초 카운트 후 시작(수정요청3 2026-06-15). 단어 풀 로드/마음의 준비 시간도 확보.
const COUNTDOWN_MS = 6000;
const HEARTBEAT_MS = 30000;
// 한 명이 먼저 끝내면 상대에게 opponent:finished 로 즉시 마무리를 알린다. 이 시간은 그래도 응답 없을 때의 폴백.
const MATCH_GRACE_MS = Number(process.env.MATCH_GRACE_MS || 6000);

// ── 인증: 쿠키 JWT → userSeq (typrain-server lib/userSession.ts 와 정렬) ──
function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function userSeqFromRequest(req: IncomingMessage): Promise<number | null> {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(JWT_SECRET));
    const seq = Number((payload as { uid?: unknown }).uid); // typrain-server: SignJWT({ uid: userSeq })
    return Number.isFinite(seq) && seq > 0 ? seq : null;
  } catch {
    return null;
  }
}

// ── 연결 상태 ───────────────────────────────────────────────────────
interface Client {
  ws: WebSocket;
  userSeq: number;
  nickname: string;
  profileImage?: string | null;
  matchId?: string;
  alive: boolean;
}

const queue = new QueueManager();
const rooms = new RoomManager(COUNTDOWN_MS);
const counter = new CounterService(queue, rooms);
const clients = new Map<number, Client>(); // userSeq → client (단일 인스턴스 전제)
const graceTimers = new Map<string, ReturnType<typeof setTimeout>>(); // matchId → 종료 유예 타이머

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function relayToOpponents(c: Client, msg: ServerMsg): void {
  if (!c.matchId) return;
  const room = rooms.get(c.matchId);
  if (!room) return;
  for (const p of room.players) {
    if (p.userSeq === c.userSeq) continue;
    const cl = clients.get(p.userSeq);
    if (cl) send(cl.ws, msg);
  }
}

// ── 매칭 → 룸 생성 → 카운트다운 → 시작 ─────────────────────────────
function tryMatch(categorySeq: number, mode: Mode): void {
  const group = queue.tryMatch(categorySeq, mode);
  if (!group) return;

  const players = group.map((e, i) => ({
    userSeq: e.userSeq,
    nickname: e.nickname,
    profileImage: e.profileImage,
    joinOrder: i,
  }));
  const room = rooms.create(categorySeq, mode, players);

  for (const p of players) {
    const cl = clients.get(p.userSeq);
    if (!cl) continue;
    cl.matchId = room.matchId;
    send(cl.ws, {
      t: 'match:found',
      matchId: room.matchId,
      mode,
      matchSeed: room.matchSeed,
      matchStartTs: room.matchStartTs,
      players,
      you: p.userSeq,
    });
  }

  setTimeout(() => {
    const r = rooms.get(room.matchId);
    if (!r) return;
    r.status = 'playing';
    const now = Date.now();
    for (const p of r.players) {
      const cl = clients.get(p.userSeq);
      if (cl) send(cl.ws, { t: 'match:start', matchId: r.matchId, serverTs: now });
    }
  }, COUNTDOWN_MS);
}

// ── 종료 집계 → match:over 브로드캐스트 (1회 보장) ──────────────────
function finalizeMatch(matchId: string): void {
  const room = rooms.get(matchId);
  if (!room || room.finalized) return;
  rooms.markFinalized(matchId);
  const timer = graceTimers.get(matchId);
  if (timer) {
    clearTimeout(timer);
    graceTimers.delete(matchId);
  }
  const results = rooms.buildResults(matchId);
  for (const p of room.players) {
    const cl = clients.get(p.userSeq);
    if (cl) {
      send(cl.ws, { t: 'match:over', matchId, results, isRanked: false }); // isRanked=영속/랭킹은 Phase 3b
      cl.matchId = undefined;
    }
  }
  rooms.finish(matchId);
}

// ── 카운트다운 중 상대 이탈 → 매치 취소(남은 인원에게 알림) ──────────
function cancelMatch(matchId: string, leaverSeq: number): void {
  const room = rooms.get(matchId);
  if (!room) return;
  for (const p of room.players) {
    if (p.userSeq === leaverSeq) continue;
    const cl = clients.get(p.userSeq);
    if (cl) {
      send(cl.ws, { t: 'match:cancelled', matchId, reason: 'opponent_left' });
      cl.matchId = undefined;
    }
  }
  const timer = graceTimers.get(matchId);
  if (timer) {
    clearTimeout(timer);
    graceTimers.delete(matchId);
  }
  rooms.finish(matchId); // 룸 삭제 → 예약된 match:start setTimeout 은 rooms.get null 로 무시됨
}

// ── 메시지 처리 ─────────────────────────────────────────────────────
function handle(c: Client, msg: ClientMsg): void {
  switch (msg.t) {
    case 'ping':
      send(c.ws, { t: 'pong', c: msg.c, srvT: Date.now() });
      break;

    case 'queue:join': {
      // 닉네임은 클라가 전달(uid 는 JWT 로 인증됨 — 닉네임은 표시용이라 위조 위험 낮음). 길이 상한.
      const nick = typeof msg.nickname === 'string' ? msg.nickname.trim().slice(0, 20) : '';
      if (nick) c.nickname = nick;
      queue.join(msg.categorySeq, msg.mode, {
        userSeq: c.userSeq,
        nickname: c.nickname,
        profileImage: c.profileImage,
        enqueuedAt: Date.now(),
      });
      send(c.ws, {
        t: 'queue:status',
        have: queue.waitingCountForMode(msg.categorySeq, msg.mode),
        need: needForMode(msg.mode),
      });
      tryMatch(msg.categorySeq, msg.mode);
      break;
    }

    case 'queue:leave':
      queue.leave(c.userSeq);
      break;

    case 'match:ready': {
      const room = rooms.get(msg.matchId);
      if (room) room.ready.add(c.userSeq);
      break;
    }

    case 'word:typing': {
      // 실시간 상대 입력 진행 중계 (소규모 방이라 부담 없음). 룸 멤버십 + 숫자 검증.
      if (!c.matchId) break;
      const spawnIndex = Number(msg.spawnIndex);
      const len = Number(msg.len);
      if (!Number.isFinite(spawnIndex) || spawnIndex < 0 || !Number.isFinite(len) || len < 0) break;
      relayToOpponents(c, {
        t: 'opponent:typing',
        userSeq: c.userSeq,
        spawnIndex: Math.trunc(spawnIndex),
        len: Math.min(64, Math.trunc(len)),
      });
      break;
    }

    case 'word:clear': {
      // 양분 모델(2026-06-15): 각자 독립 필드를 가진다(선착 경쟁 폐기). 상대에게 "내가 이 단어를 깼다"만 중계해
      // 상대 화면의 내 미러뷰(점수/콤보/별똥별)를 갱신한다. 점수 권위 검증은 Phase 3b(서버 단어풀 확보 후).
      if (!c.matchId) break;
      const spawnIndex = Number(msg.spawnIndex);
      const comboAfter = Number(msg.comboAfter);
      if (!Number.isFinite(spawnIndex) || spawnIndex < 0 || !Number.isFinite(comboAfter)) break;
      relayToOpponents(c, {
        t: 'opponent:clear',
        userSeq: c.userSeq,
        spawnIndex: Math.trunc(spawnIndex),
        scoreDelta: 0,
        totalScore: 0,
        combo: Math.max(1, Math.min(500, Math.trunc(comboAfter))), // 악성 콤보 부풀리기 방어
        isFirst: true,
        serverTs: Date.now(),
      });
      break;
    }

    case 'state:update': {
      // 상대 미러뷰의 점수/콤보/생명 동기화(스로틀해서 보냄). 신뢰값은 클램프만(영속 아님).
      if (!c.matchId) break;
      const clampN = (n: unknown, max: number): number => {
        const v = Number(n);
        return Number.isFinite(v) && v >= 0 ? Math.min(max, Math.trunc(v)) : 0;
      };
      relayToOpponents(c, {
        t: 'opponent:state',
        userSeq: c.userSeq,
        score: clampN(msg.score, 10_000_000),
        combo: clampN(msg.combo, 500),
        hp: clampN(msg.hp, 10),
      });
      break;
    }

    case 'item:used': {
      // 공격형(negative) 아이템만 클라가 전송 → 단일 상대에게 그대로 적용(2인 자동조준). 버프형은 본인 로컬 적용이라 미전송.
      if (!c.matchId) break;
      relayToOpponents(c, { t: 'item:used', userSeq: c.userSeq, effect: msg.effect, targetSeq: 0 });
      break;
    }

    case 'match:finish': {
      if (!c.matchId || !rooms.get(c.matchId)) break;
      const clamp = (n: unknown): number => {
        const v = Number(n);
        return Number.isFinite(v) && v >= 0 ? Math.min(10_000_000, Math.trunc(v)) : 0;
      };
      rooms.recordFinish(c.matchId, c.userSeq, {
        score: clamp(msg.clientScore),
        maxCombo: clamp(msg.maxCombo),
        correct: clamp(msg.correct),
        miss: clamp(msg.miss),
        abandoned: false,
      });
      if (rooms.allFinished(c.matchId)) {
        finalizeMatch(c.matchId);
      } else {
        // 한 명 먼저 끝 → 상대에게 즉시 마무리 신호(바로 끝나게) + grace 폴백.
        relayToOpponents(c, { t: 'opponent:finished', userSeq: c.userSeq });
        if (!graceTimers.has(c.matchId)) {
          const mid = c.matchId;
          graceTimers.set(mid, setTimeout(() => finalizeMatch(mid), MATCH_GRACE_MS));
        }
      }
      break;
    }

    case 'match:resync':
    case 'word:miss':
      // TODO(P3): 리커넥트 resync / HP 처리.
      break;
  }
}

// ── 서버 부트스트랩 ─────────────────────────────────────────────────
const httpServer = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, clients: clients.size, ts: Date.now() }));
    return;
  }

  // 접속자 카운터 — Next /api/battle/status 가 서버-투-서버로 호출 (게임중/대기중)
  if (url.pathname === '/counts') {
    const categorySeq = Number(url.searchParams.get('categorySeq'));
    if (!Number.isFinite(categorySeq) || categorySeq <= 0) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'categorySeq required' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, categorySeq, ...counter.counts(categorySeq) }));
    return;
  }

  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  void (async () => {
    const userSeq = await userSeqFromRequest(req);
    if (!userSeq) {
      send(ws, { t: 'error', code: '401', message: '로그인이 필요합니다.' });
      ws.close();
      return;
    }
    // TODO: nickname/profileImage 는 추후 Prisma 조회로 채움
    const client: Client = { ws, userSeq, nickname: `user${userSeq}`, alive: true };
    clients.set(userSeq, client);

    ws.on('pong', () => { client.alive = true; });
    ws.on('message', (data: RawData) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(data.toString()) as ClientMsg;
      } catch {
        return;
      }
      handle(client, msg);
    });
    ws.on('close', () => {
      queue.leave(userSeq);
      // 진행 중 매치에서 이탈 → abandoned(score 0) 기록 후 종료 조건 확인(상대 무한대기 방지).
      const mid = client.matchId;
      if (mid) {
        const room = rooms.get(mid);
        if (room && !room.finalized) {
          if (room.status === 'countdown') {
            // 시작 전(카운트다운) 이탈 → 매치 취소: 남은 인원에게 알리고 룸 폐기(혼자 시작 방지).
            cancelMatch(mid, userSeq);
          } else {
            rooms.recordFinish(mid, userSeq, { score: 0, maxCombo: 0, correct: 0, miss: 0, abandoned: true });
            if (rooms.allFinished(mid)) finalizeMatch(mid);
          }
        }
      }
      // 재연결로 교체된 새 클라이언트는 지우지 않음(이 연결의 client 일 때만).
      if (clients.get(userSeq) === client) clients.delete(userSeq);
    });
  })();
});

// 하트비트 — idle 끊김 방지 + 죽은 연결 정리
setInterval(() => {
  for (const c of clients.values()) {
    if (!c.alive) {
      c.ws.terminate();
      continue;
    }
    c.alive = false;
    try { c.ws.ping(); } catch { /* ignore */ }
  }
}, HEARTBEAT_MS);

httpServer.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[typrun-ws] listening on :${PORT} (ws: /ws · health: /healthz) · counter ready=${!!counter}`);
});
