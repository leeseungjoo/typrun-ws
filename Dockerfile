# typrun-ws — 배틀 실시간 서버 (native ws). tsc 빌드 → node dist/server.js
# Coolify: 포트 3001, 헬스 GET /healthz.
# 필수 env: JWT_SECRET(미설정 시 프로덕션 기동 거부), COOKIE_DOMAIN=.typrun.com
# 선택 env: MATCH_GRACE_MS, PORT(기본 3001)
FROM node:22-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build               # tsc → dist/

FROM base AS runner
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev           # 런타임 의존성만(ws, jose)
COPY --from=build /app/dist ./dist
EXPOSE 3001
CMD ["node", "dist/server.js"]
