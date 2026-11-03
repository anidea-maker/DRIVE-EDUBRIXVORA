# Single-service image: Express API + the built SPA on one origin.
#
# Why: with the frontend and backend as separate services you have to keep
# API_UPSTREAM, VITE_API_URL and CORS in sync, and getting any of them wrong shows
# up as a mysterious "Unexpected token '<'" or 405. Here the browser calls /api on
# the same origin it loaded the page from, so there is nothing to configure.
#
# Render (or any Docker host):
#   Runtime: Docker, Dockerfile Path: ./Dockerfile, Health Check: /health
#   Env: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, JWT_ACCESS_SECRET,
#        TOKEN_ENCRYPTION_KEY   (or a single DATABASE_URL=libsql://...?authToken=...)
#   (FRONTEND_URL is optional - it defaults to this service's own origin)
#
# The two-service setup still works: use backend/Dockerfile + frontend/Dockerfile.

# ---------- frontend build ----------
FROM node:20-alpine AS frontend

WORKDIR /app

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
# Same-origin API: the app calls /api and this server answers it.
ENV VITE_API_URL=/api
RUN npm run build

# ---------- backend build ----------
FROM node:20-alpine AS backend

WORKDIR /app

COPY backend/package*.json ./
COPY backend/prisma ./prisma
RUN npm ci

COPY backend/tsconfig.json ./
COPY backend/prisma.config.ts ./
COPY backend/src ./src
COPY backend/scripts ./scripts
# No native query engine: the client uses the WASM compiler + the libSQL adapter.
RUN npx prisma generate && npm run build

# ---------- runtime ----------
FROM node:20-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    APP_PORT=4000 \
    SERVE_FRONTEND=/app/public

COPY --from=backend /app/node_modules ./node_modules
COPY --from=backend /app/dist ./dist
COPY --from=backend /app/prisma ./prisma
COPY --from=backend /app/scripts ./scripts
COPY --from=backend /app/package.json ./package.json
COPY --from=frontend /app/dist ./public

# `prisma migrate deploy` runs on boot against Turso; `ensure-env` refuses to start
# without database credentials instead of failing later with an opaque P1012.
# Migrations are fatal (a missing database should fail loudly), but the Google
# seed is not: a missing/invalid OAuth client must never stop the API from
# booting, or nobody can register an email/password account.
CMD ["sh", "-c", "npm run db:migrate:deploy && { npm run seed:google-config:docker || echo '[startup] google config seed skipped'; } && node dist/server.js"]

EXPOSE 4000
