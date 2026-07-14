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

CMD ["npm", "run", "dev"]
