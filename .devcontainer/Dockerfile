FROM mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm

# Tooling: postgres-client (psql), build deps for native modules
# (better-sqlite3 rebuilds inside the container).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      postgresql-client \
      build-essential \
      python3 \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && corepack prepare pnpm@latest --activate
