<div align="center">
  <a href="https://readest.com?utm_source=github&utm_medium=referral&utm_campaign=readme" target="_blank">
    <img src="https://github.com/readest/readest/blob/main/apps/readest-app/src-tauri/icons/icon.png?raw=true" alt="Readest Logo" width="20%" />
  </a>
  <h1>Readen - Cloudflare selfhost (unofficial)</h1>
  <br>

This is a **unofficial version** of Readest, which makes you deploy Readest on Cloudflare. If you encounter any issues, report it on this repository, **DO NOT** open issue on Readest official repo.

<br>

</div>

## Key changes

<div align="left">✅ Implemented</div>

| Changes   | Description                               | Status |
| --------- | ----------------------------------------- | ------ |
| Framework | From Next.js to Tanstack Start            | 🔄     |
| Auth      | From Supabase to better auth              | 🔄     |
| Database  | From Supabase postgreSQL to Cloudflare D1 | 🔄     |
| Storage   | From Supabase storage to Cloudflare R2    | 🔄     |

## Requirements

- **Node.js** and **pnpm** for Next.js development
- **Rust** and **Cargo** for Tauri development

```bash
nvm install v24
nvm use v24
npm install -g pnpm
rustup update
```

## Getting Started

To get started with Readest, follow these steps to clone and build the project.

### 1. Clone the Repository

```bash
git clone https://github.com/0x0501/readen.git
cd readen
```

### 2. Install Dependencies

```bash
# might need to rerun this when code is updated
git submodule update --init --recursive
pnpm install
# copy vendors dist libs to public directory
pnpm --filter @readest/readest-app setup-vendors
```

### 3. Verify Dependencies Installation

To confirm that all dependencies are correctly installed, run the following command:

```bash
pnpm tauri info
```

This command will display information about the installed Tauri dependencies and configuration on your platform. Note that the output may vary depending on the operating system and environment setup. Please review the output specific to your platform for any potential issues.

For Windows targets, “Build Tools for Visual Studio 2022” (or a higher edition of Visual Studio) and the “Desktop development with C++” workflow must be installed. For Windows ARM64 targets, the “VS 2022 C++ ARM64 build tools” and "C++ Clang Compiler for Windows" components must be installed. And make sure `clang` can be found in the path by adding `C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\Llvm\x64\bin` for example in the environment variable `Path`.

### 4. Build for Development

#### Web app

The web app needs Postgres (with the `readest_app` role + RLS policies
bootstrapped), S3-compatible storage (MinIO), and SMTP (Mailpit, so
better-auth verification / magic-link emails are inspectable in a
browser). `docker/compose.dev.yaml` brings up those local dependencies; run
Drizzle migrations manually from the app package:

```bash
# 1. Env files (edit afterwards: set BETTER_AUTH_SECRET to `openssl rand -hex 32`)
cp docker/.env.example docker/.env
cp apps/readest-app/.env.web.example apps/readest-app/.env.web

# 2. Start infra
docker compose -f docker/compose.dev.yaml --env-file docker/.env up -d

# 3. Apply migrations from apps/readest-app/.env DATABASE_URL
cd apps/readest-app
pnpm db:migrate
cd ../..

# 4. Run the dev server on the host
pnpm dev-web
```

Then open http://localhost:5173. Mailpit web UI is at
http://localhost:8025; MinIO console at http://localhost:9001.

After any schema change, re-apply migrations with `pnpm db:migrate` from
`apps/readest-app`.

#### VSCode devcontainer (alternative)

The repo ships a `.devcontainer/` config that includes the same infra
plus an `app` container with Node 22 + pnpm + psql. In VSCode: command
palette → **Dev Containers: Reopen in Container**. Once attached, run
`pnpm dev-web` from the integrated terminal; port 5173 is auto-forwarded.

#### Other targets

```bash
# Tauri desktop app
pnpm tauri dev
# Web app preview with OpenNext build
pnpm preview
```

For Android:

```bash
# Initialize the Android environment (run once)
rm apps/readest-app/src-tauri/gen/android
pnpm tauri android init
pnpm tauri icon ../../data/icons/readest-book.png
git checkout apps/readest-app/src-tauri/gen/android

pnpm tauri android dev
# or if you want to dev on a real device
pnpm tauri android dev --host
```

For iOS:

```bash
# Set up the iOS environment (run once)
pnpm tauri ios init
pnpm tauri icon ../../data/icons/readest-book.png

pnpm tauri ios dev
# or if you want to dev on a real device
pnpm tauri ios dev --host
```

### 5. Build for Production

```bash
pnpm tauri build
pnpm tauri android build
pnpm tauri ios build
```

Please refer to our release script if you experience any issues:
https://github.com/readest/readest/blob/main/.github/workflows/release.yml

### 6. Setup dev environment with Nix

If you have Nix installed, you can leverage flake to enter a development shell
with all the necessary dependencies:

```bash
nix develop ./ops  # enter a dev shell for the web app
nix develop ./ops#ios # enter a dev shell for the ios app
nix develop ./ops#android # enter a dev shell for the android app
```

## License

Readest is free software: you can redistribute it and/or modify it under the terms of the [GNU Affero General Public License](https://www.gnu.org/licenses/agpl-3.0.html) as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. See the [LICENSE](LICENSE) file for details.
