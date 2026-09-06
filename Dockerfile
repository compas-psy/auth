# ── Сборка портала ────────────────────────────────────────────────────
FROM node:22-alpine AS portal-build
WORKDIR /build
COPY portal/package.json portal/package-lock.json* ./portal/
COPY server/package.json ./server/
RUN cd portal && npm ci --no-audit --no-fund
COPY portal ./portal
# Портал импортирует реестр формулировок из сервера: он один на оба.
COPY server/src/ui/wording.ts ./server/src/ui/wording.ts
RUN cd portal && npm run build

# ── Сборка ресурса разработчика ───────────────────────────────────────
FROM node:22-alpine AS devsite-build
WORKDIR /build
COPY devsite/package.json devsite/package-lock.json* ./devsite/
RUN cd devsite && npm ci --no-audit --no-fund
COPY devsite ./devsite
COPY server/openapi ./server/openapi
COPY docs/CHANGELOG-api.md ./docs/CHANGELOG-api.md
RUN cd devsite && npm run build

# ── Сборка сервера ────────────────────────────────────────────────────
FROM node:22-alpine AS server-build
WORKDIR /build/server
COPY server/package.json server/package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

# ── Зависимости для выполнения, без сборочных ─────────────────────────
FROM node:22-alpine AS deps
WORKDIR /build/server
COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

# ── Образ ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
# curl нужен HEALTHCHECK: без него проверка здоровья не отличит
# «поднимается» от «упало».
RUN apk add --no-cache curl

ENV NODE_ENV=production
WORKDIR /app

# Непривилегированный пользователь. Образ, работающий от root, — лишний
# способ превратить ошибку в контейнере в ошибку на хосте.
RUN addgroup -g 10001 -S simpas && adduser -u 10001 -S simpas -G simpas

COPY --from=deps        --chown=simpas:simpas /build/server/node_modules ./node_modules
COPY --from=server-build --chown=simpas:simpas /build/server/dist ./dist
COPY --from=server-build --chown=simpas:simpas /build/server/package.json ./package.json
COPY --chown=simpas:simpas server/openapi ./openapi
COPY --from=portal-build  --chown=simpas:simpas /build/portal/dist ./portal
COPY --from=devsite-build --chown=simpas:simpas /build/devsite/dist ./devsite

# Ключи подписи живут в томе, а не в образе: образ публичен по смыслу,
# ключи — нет. Сервис заводит их сам при первом запуске (Р-3).
ENV KEYS_DIR=/var/lib/simpasid/keys
ENV PORTAL_DIST=/app/portal
ENV DEVSITE_DIST=/app/devsite
RUN mkdir -p /var/lib/simpasid/keys && chown -R simpas:simpas /var/lib/simpasid
VOLUME ["/var/lib/simpasid"]

USER simpas
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "dist/index.js"]
