FROM node:22-alpine

RUN corepack enable

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Build
COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm build

# Tokens and credentials are stored in ~/.mcp-auth — mount a volume here to persist them
VOLUME /root/.mcp-auth

EXPOSE 3333

# Bind to all interfaces so Docker port-mapping works.
# Tokens are stored in /root/.mcp-auth — mount a volume to persist them across restarts.
ENTRYPOINT ["node", "dist/server.js", "--listen-host", "0.0.0.0"]
