# Two stages so the runtime image carries no compiler and no dev dependencies.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app

# The mirror keeps a git repository per project; the OAuth store is a JSON file.
RUN apk add --no-cache git tini

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/dist ./dist

# Mirrors are written here, so the unprivileged user must own it. HOME is pointed at the
# volume too: a dependency resolves its config directory from HOME, and a missing or
# read-only home makes it throw during import.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
ENV NODE_ENV=production OLMCP_DATA_DIR=/data HOME=/data

EXPOSE 8080
VOLUME ["/data"]

# tini reaps the short-lived `git` child processes the mirror spawns.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]