FROM node:24-slim AS base

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY docs ./docs
COPY README.md ./

RUN npm ci --omit=dev

EXPOSE 8787

# Node is started directly, not through npm, so that the SIGTERM a container
# gets on stop reaches the resolver and it can finish what it is doing.
CMD ["node", "apps/resolver/src/server.js"]
