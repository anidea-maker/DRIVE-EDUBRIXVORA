FROM node:20-alpine AS base

WORKDIR /app

# Runtime stage only: the build stage still needs devDependencies (tsc/prisma).
ENV NODE_ENV=production

COPY package*.json ./
COPY prisma ./prisma

RUN npm ci

COPY tsconfig.json ./
COPY prisma.config.ts ./
COPY src ./src
COPY scripts ./scripts

# No native engine is downloaded: `engineType = "client"` uses the WASM query
# compiler and talks to Turso through @prisma/adapter-libsql.
RUN npx prisma generate && npm run build

EXPOSE 4000

CMD ["sh", "-c", "npm run db:migrate:deploy && npm run seed:google-config:docker && node dist/server.js"]
