# typrun-ws

Typ Run 배틀모드 **실시간 서버** (네이티브 `ws`). 단판 게임 자산은 그대로 두고, 배틀의 매칭·룸·이벤트 중계만 담당한다. 설계서: `기획/TypRun_배틀모드_기술설계서.md`.

## 역할
- 매칭 큐(`${categorySeq}:${mode}` FIFO) → 인원 충족 시 룸 생성 → 카운트다운 → 동시 시작
- **공유 시드 + 이벤트 중계**: 풀(낙하 단어) 위치는 안 보냄. `word:clear`/`word:typing`/`item:used`만 중계
- 접속자 카운터(게임중/대기중), 하트비트, JWT 쿠키 핸드셰이크

## 구조
```
src/
  protocol.ts   메시지 타입 (C→S / S→C, 설계서 §3.4)
  managers.ts   QueueManager · RoomManager(FSM) · CounterService
  server.ts     http(/healthz) + ws(/ws) + 매칭/중계 라우팅 + 인증
```

## 실행
```bash
cp .env.example .env   # JWT_SECRET 등 채우기 (typrain-server 와 동일 시크릿)
npm install
npm run dev            # tsx watch
# 또는
npm run build && npm start
```
- WebSocket: `ws://localhost:3001/ws`  · Health: `http://localhost:3001/healthz`

## 현재 상태 (P0~P1 뼈대)
- ✅ 큐/룸/매칭(2·3인)·카운트다운·시작, 이벤트 중계 스텁, healthz, 하트비트
- ✅ **인증 정렬됨** — typrain-server(`lib/userSession.ts`)와 동일: `typrun_session` 쿠키 · HS256 · 페이로드 `{ uid }`. prod 는 `JWT_SECRET` 를 typrain-server 와 동일 설정.
- ⬜ **TODO(P2)**: `word:clear` 서버 권위 검증(시간창/중복/선착), 공격 아이템 자동조준(선두), 종료 집계·Prisma 영속, 리커넥트(resync), nickname/profile DB 조회
