FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY docs ./docs
COPY README.md ./

RUN npm ci --omit=dev

# Everything runs as the image's unprivileged "node" user. It can write in two
# places only: the directory of the file store, and the directory in which the
# RPC relay's two containers share a socket.
RUN mkdir -p /app/apps/resolver/data /run/fiber-rpc \
  && chown node:node /app/apps/resolver/data /run/fiber-rpc
USER node

EXPOSE 8787

# Node is started directly, not through npm, so that the SIGTERM a container
# gets on stop reaches the resolver and it can finish what it is doing.
CMD ["node", "apps/resolver/src/server.js"]
