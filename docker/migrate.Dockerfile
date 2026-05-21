# Image used by docker/compose.dev.yaml's `migrate` one-shot service.
# Installs only the deps drizzle needs to apply migrations, then runs
# the same migrate script the host uses via `pnpm db:migrate`.
#
# First build of the image is slow (~3-5 min). After that, layers are
# cached and the migrate step on `docker compose up` is seconds-fast.

FROM node:22-bookworm-slim

ENV PNPM_HOME=/usr/local/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

WORKDIR /repo

# Copy just enough to install workspace deps. node_modules lands in the
# image layer; subsequent rebuilds skip unless the lockfile changes.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/readest-app/package.json apps/readest-app/
COPY packages/foliate-js/package.json packages/foliate-js/
# pnpm-workspace.yaml declares patchedDependencies pointing into ./patches/
# so those files must be present at install time even though drizzle itself
# doesn't need them.
COPY patches/ patches/
RUN pnpm install --filter @readest/readest-app --frozen-lockfile --ignore-scripts

# Only the files the migrate script reads. The rest of the repo is left
# out so editing app code doesn't bust this image's cache.
COPY apps/readest-app/tsconfig.json apps/readest-app/
COPY apps/readest-app/drizzle.config.ts apps/readest-app/
COPY apps/readest-app/src/db apps/readest-app/src/db

WORKDIR /repo/apps/readest-app

# Bypass the package.json's `dotenv -e .env -- tsx ...` script — there's
# no .env file inside the container; DATABASE_URL comes from compose env.
CMD ["pnpm", "exec", "tsx", "src/db/migrate.ts"]
