# Self-Hosting with Docker/Podman with Compose

## Stack

| service         | Image                  | Description                                                  |
| --------------- | ---------------------- | ------------------------------------------------------------ |
| **client**      | from `../Dockerfile`   | readest frontend (better-auth lives in-process)              |
| **db**          | `postgres:16-alpine`   | psql db; `readest_app` role bootstrapped on first boot       |
| **minio**       | `minio/minio`          | s3 storage                                                   |
| **minio-setup** | `minio/mc`             | helper container to create s3 buckets                        |
| **mailpit**     | `axllent/mailpit`      | dev SMTP sink for better-auth verification / magic-link mail |

### Exposed ports

| Port   | Service          |
| ------ | ---------------- |
| `3000` | readest          |
| `5432` | Postgres         |
| `9000` | MinIO S3 API     |
| `9001` | MinIO console UI |
| `1025` | Mailpit SMTP     |
| `8025` | Mailpit web UI   |

---

## Running with Docker/Podman Compose

### 1. setup .env

```bash
cp docker/.env.example docker/.env
```

update `docker/.env`:

- update `POSTGRES_PASSWORD` to a strong password
- set `BETTER_AUTH_SECRET` to 32 bytes of hex (`openssl rand -hex 32`)
- set `MINIO_ROOT_PASSWORD` to a strong password
- for production email, set `RESEND_API_KEY`; leave blank to use Mailpit for local dev

### 2. Start the Stack

run from the `docker/` directory:

```bash
cd docker
docker compose up --build -d
```

the client image is built locally on first run. subsequent starts reuse the cached image.

### 3. Apply drizzle migrations

The Postgres init script creates the `readest_app` role; the application's
drizzle migrations create the tables, RLS policies, and stored functions.
Run them once after the stack is up:

```bash
cd ../apps/readest-app
DATABASE_URL=postgres://postgres:$POSTGRES_PASSWORD@localhost:5432/postgres pnpm db:migrate
```

(Migrations connect as `postgres` so they can `CREATE ROLE`, `CREATE EXTENSION`, etc.; the running app connects as `readest_app` per `DATABASE_URL` in `compose.yaml`.)

### 4. Access

- Readest app: `http://localhost:3000`
- MinIO console: `http://localhost:9001` (login with `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`)
- Mailpit (dev mail): `http://localhost:8025`

### Hot Reload (development)

to develop using the compose stack, set the build target on `client` to `development-stage`, which'll runs the dev server. to enable hot reload, uncomment the `volumes` block in the `client` service in `compose.yaml`:

```yaml
volumes:
  - ../:/app
  - /app/node_modules
  - /app/apps/readest-app/node_modules
  - /app/apps/readest-app/public/vendor
  - /app/apps/readest-app/.next
  - /app/packages/foliate-js/node_modules
```

the first mount overlays your local repo into the container. the remaining anonymous volumes shadow the directories that were pre-built inside the image, so the container's installed deps and vendor assets are used instead of what's on your host.

### Stop the Stack

```bash
cd docker
docker compose down
```

to also remove volumes (database and storage data):

```bash
cd docker
docker compose down -v
```

---

## Local development without Docker

If you only need a Postgres + S3 + SMTP for `pnpm dev-web`, you can bring up
just the dependencies and run the app locally:

```bash
cd apps/readest-app
cp .env.web.example .env
cd ../../docker
docker compose up -d db minio minio-setup mailpit
cd ../apps/readest-app
pnpm db:migrate
pnpm dev-web
```

---

## Building the Dockerfile standalone

the `Dockerfile` requires Build args for the public env vars (they are inlined at build time)

```bash
docker build \
  --target production-stage \
  --build-arg VITE_APP_PLATFORM=web \
  --build-arg VITE_BETTER_AUTH_URL=http://localhost:3000 \
  --build-arg NEXT_PUBLIC_API_BASE_URL=http://localhost:3000 \
  --build-arg NEXT_PUBLIC_OBJECT_STORAGE_TYPE=s3 \
  --build-arg NEXT_PUBLIC_STORAGE_FIXED_QUOTA=1073741824 \
  --build-arg NEXT_PUBLIC_TRANSLATION_FIXED_QUOTA=50000 \
  -t readest-client \
  .
```

run the built image:

```bash
docker run -p 3000:3000 \
  -e BETTER_AUTH_SECRET=<32-byte-hex> \
  -e BETTER_AUTH_URL=http://localhost:3000 \
  -e DATABASE_URL=postgres://readest_app:readest_app@host.docker.internal:5432/postgres \
  -e S3_ENDPOINT=http://localhost:9000 \
  -e S3_REGION=us-east-1 \
  -e S3_BUCKET_NAME=readest-files \
  -e S3_ACCESS_KEY_ID=<minio-user> \
  -e S3_SECRET_ACCESS_KEY=<minio-password> \
  -e SMTP_HOST=host.docker.internal \
  -e SMTP_PORT=1025 \
  readest-client
```
