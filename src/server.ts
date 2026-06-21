import { createServer, type IncomingMessage } from 'http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { jwtVerify } from 'jose';
import { QueueManager, RoomManager, CounterService, PrivateRoomManager } from './managers';
import type { ClientMsg, ServerMsg, Mode, PlayerInfo } from './protocol';
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

// ── 게스트 식별 (비회원 친구 초대 입장용) ────────────────────────────
// 실회원 seq 는 항상 양수(autoincrement). 게스트는 음수 seq 를 부여해 매치 파이프라인(clients/relay/결과)을
// 그대로 재사용하면서 충돌을 막는다. 클라가 보낸 안정 토큰(?guest=)에 음수 seq 를 1:1 매핑 → 재연결해도 동일 seq 유지.
const guestSeqByToken = new Map<string, number>();
let nextGuestSeq = -1;
function guestSeqFor(token: string): number {
  let s = guestSeqByToken.get(token);
  if (s == null) {
    s = nextGuestSeq--;
    guestSeqByToken.set(token, s);
  }
  return s;
}

// 게스트 토큰 형식 검증 — 빈/짧은(추측 가능)/거대 토큰 거절. 웹 클라는 ~20자 영숫자.
const GUEST_TOKEN_RE = /^[A-Za-z0-9_-]{8,128}$/;

// ── 연결 상태 ───────────────────────────────────────────────────────
interface Client {
  ws: WebSocket;
  userSeq: number;
  nickname: string;
  profileImage?: string | null;
  matchId?: string;
  alive: boolean;
  guestToken?: string; // 게스트면 토큰 보관(끊길 때 매핑 회수해 누수 방지)
}

const queue = new QueueManager();
const rooms = new RoomManager(COUNTDOWN_MS);
const privateRooms = new PrivateRoomManager(); // 친구 초대 대결 대기방(코드 기반)
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

// ── 룸 생성 → match:found → 카운트다운 → match:start (랜덤·사설 공용) ──
function startMatch(categorySeq: number, mode: Mode, players: PlayerInfo[]): void {
  const room = rooms.create(categorySeq, mode, players);

  for (const p of players) {
    const cl = clients.get(p.userSeq);
    if (!cl) continue;
    cl.matchId = room.matchId;
    send(cl.ws, {
      t: 'match:found',
      matchId: room.matchId,
      mode,
      categorySeq,
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

// ── 랜덤 매칭 → 룸 시작 ─────────────────────────────────────────────
function tryMatch(categorySeq: number, mode: Mode): void {
  const group = queue.tryMatch(categorySeq, mode);
  if (!group) return;
  const players: PlayerInfo[] = group.map((e, i) => ({
    userSeq: e.userSeq,
    nickname: e.nickname,
    profileImage: e.profileImage,
    joinOrder: i,
  }));
  startMatch(categorySeq, mode, players);
}

// ── 친구 초대 대결: 대기방 인원 충족 → 룸 시작 ──────────────────────
function promotePrivate(code: string): void {
  const room = privateRooms.take(code);
  if (!room) return;
  // 승격되는 모든 멤버는 큐에 남아있을 수 있으니 제거(이중 매칭 방지).
  for (const m of room.members) queue.leave(m.userSeq);
  const players: PlayerInfo[] = room.members.map((m, i) => ({
    userSeq: m.userSeq,
    nickname: m.nickname,
    profileImage: m.profileImage,
    joinOrder: i,
  }));
  startMatch(room.categorySeq, room.mode, players);
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
      if (c.matchId && rooms.get(c.matchId)) break; // 이미 진행중 매치 → 이중 매칭 방지(다른 탭/경로 재진입)
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

    case 'room:create': {
      if (c.matchId && rooms.get(c.matchId)) break; // 이미 진행중 매치 → 무시(이중 매칭 방지)
      // 친구 초대 대결 방 생성 — 로그인 필요(호스트는 초대장 주인). 게스트(음수 seq)는 거절.
      if (c.userSeq < 0) {
        send(c.ws, { t: 'room:error', reason: 'login_required', message: '로그인이 필요합니다.' });
        break;
      }
      const mode: Mode = msg.mode === '3p' ? '3p' : '2p';
      const categorySeq = Number(msg.categorySeq);
      if (!Number.isFinite(categorySeq) || categorySeq <= 0) {
        send(c.ws, { t: 'room:error', reason: 'bad_request', message: '리그 정보가 올바르지 않습니다.' });
        break;
      }
      const nick = typeof msg.nickname === 'string' ? msg.nickname.trim().slice(0, 20) : '';
      if (nick) c.nickname = nick;
      const room = privateRooms.createOrGet(c.userSeq, categorySeq, mode, {
        userSeq: c.userSeq,
        nickname: c.nickname,
        profileImage: c.profileImage,
      });
      send(c.ws, {
        t: 'room:created',
        code: room.code,
        categorySeq,
        mode,
        have: room.members.length,
        need: needForMode(mode),
      });
      break;
    }

    case 'room:join': {
      if (c.matchId && rooms.get(c.matchId)) break; // 이미 진행중 매치 → 무시(이중 매칭 방지)
      const code = typeof msg.code === 'string' ? msg.code.trim().toUpperCase().slice(0, 12) : '';
      const nick = typeof msg.nickname === 'string' ? msg.nickname.trim().slice(0, 20) : '';
      if (nick) c.nickname = nick;
      if (!code) {
        send(c.ws, { t: 'room:error', reason: 'not_found', message: '초대 코드가 없습니다.' });
        break;
      }
      const res = privateRooms.join(code, {
        userSeq: c.userSeq,
        nickname: c.nickname,
        profileImage: c.profileImage,
      });
      if (!res.ok) {
        send(c.ws, {
          t: 'room:error',
          reason: res.reason,
          message: res.reason === 'full' ? '방이 가득 찼습니다.' : '방을 찾을 수 없습니다(만료되었거나 닫힘).',
        });
        break;
      }
      const need = needForMode(res.room.mode);
      if (res.ready) {
        promotePrivate(code); // 인원 충족 → match:found 로 전환
      } else {
        // 아직 대기 중 — 현재 멤버 전원에게 인원 갱신.
        for (const m of res.room.members) {
          const cl = clients.get(m.userSeq);
          if (cl) send(cl.ws, { t: 'room:waiting', code: res.room.code, have: res.room.members.length, need });
        }
      }
      break;
    }

    case 'room:leave': {
      // 호스트면 방 폐기(잔여 멤버 통보), 입장자면 멤버에서만 제거.
      const closedOthers = privateRooms.removeByHost(c.userSeq);
      for (const seq of closedOthers) {
        const cl = clients.get(seq);
        if (cl) send(cl.ws, { t: 'room:error', reason: 'not_found', message: '상대가 방을 닫았습니다.' });
      }
      privateRooms.removeMember(c.userSeq);
      break;
    }

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

    case 'effect:sync': {
      // 공유필드: 낙하속도/정지 효과(거북이/멈춤/가속)를 상대 필드에도 동일 적용 → 두 화면 동기화.
      if (!c.matchId) break;
      relayToOpponents(c, { t: 'opponent:effect', effect: msg.effect });
      break;
    }

    case 'field:mutate': {
      // 공유필드: 단어 추가/제거 아이템(폭탄·저격·단어폭주)을 상대 필드에도 동일 적용.
      if (!c.matchId) break;
      if (msg.op !== 'bomb' && msg.op !== 'snipe' && msg.op !== 'burst') break;
      const ids = Array.isArray(msg.ids) ? msg.ids.filter((n) => Number.isFinite(n)).slice(0, 50) : undefined;
      const adds = Array.isArray(msg.adds) ? msg.adds.slice(0, 16) : undefined;
      relayToOpponents(c, { t: 'opponent:mutate', op: msg.op, ids, adds });
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
    let resolvedSeq = await userSeqFromRequest(req);
    let nickname: string;
    let guestToken: string | undefined;
    if (resolvedSeq) {
      // TODO: nickname/profileImage 는 추후 Prisma 조회로 채움
      nickname = `user${resolvedSeq}`;
    } else {
      // 비회원 게스트 — ?guest=<토큰> 가 있으면 안정 음수 seq 부여(친구 초대 입장 전용).
      // 토큰 없으면 거절: 랜덤배틀/일반접속은 여전히 로그인 필요(기존 동작 유지).
      const url = new URL(req.url || '/', 'http://localhost');
      const tok = url.searchParams.get('guest');
      if (!tok || !GUEST_TOKEN_RE.test(tok)) {
        // 토큰 없음/형식 위반 → 거절(빈·짧은·거대 토큰으로 인한 추측·남용 방지).
        send(ws, { t: 'error', code: '401', message: '로그인이 필요합니다.' });
        ws.close();
        return;
      }
      guestToken = tok;
      resolvedSeq = guestSeqFor(tok);
      const n = (url.searchParams.get('n') || '').trim().slice(0, 20);
      nickname = n || '게스트';
    }
    const userSeq: number = resolvedSeq;
    // 같은 seq 의 이전 연결이 살아있으면(재연결/멀티탭/충돌) 조용한 이중소유 대신 명시적으로 닫는다.
    const prev = clients.get(userSeq);
    if (prev && prev.ws !== ws) {
      try { prev.ws.close(); } catch { /* ignore */ }
    }
    const client: Client = { ws, userSeq, nickname, alive: true, guestToken };
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
      // ★ stale 가드: 재연결/교체로 이미 다른 연결이 이 seq 를 차지했으면 이 죽은 소켓은 아무 정리도 안 한다.
      // (BattleSocket 자동재연결 시 stale close 가 방/매치를 부수면 블립 한 번에 초대링크·진행중 매치가 날아간다.)
      if (clients.get(userSeq) !== client) return;

      queue.leave(userSeq);
      // 호스트 대기방은 끊겨도 즉시 폐기하지 않음 — 블립 후 재연결 시 같은 코드 유지(명시적 room:leave·30분 TTL 로만 회수).
      // 입장자(비호스트)만 대기방에서 제거하고 인원 갱신.
      const affected = privateRooms.removeMember(userSeq);
      if (affected) {
        const need = needForMode(affected.mode);
        for (const m of affected.members) {
          const cl = clients.get(m.userSeq);
          if (cl) send(cl.ws, { t: 'room:waiting', code: affected.code, have: affected.members.length, need });
        }
      }
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
      // 게스트 토큰 매핑 회수(메모리 누수 방지) — 이 live 연결이 진짜 끊긴 것이므로(재연결은 위 가드로 이미 return).
      if (client.guestToken) guestSeqByToken.delete(client.guestToken);
      clients.delete(userSeq); // 가드 통과 = 이 client 가 슬롯 주인.
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

// 오래된 친구 초대 대기방 청소(친구가 안 들어온 채 방치된 코드 회수).
setInterval(() => privateRooms.sweep(Date.now()), 5 * 60 * 1000);

httpServer.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[typrun-ws] listening on :${PORT} (ws: /ws · health: /healthz) · counter ready=${!!counter}`);
});
