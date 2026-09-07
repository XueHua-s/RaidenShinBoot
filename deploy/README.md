# Docker server deployment

Run commands from the repository root. This compose file uses prebuilt images,
persistent data volumes, automatic restarts, and bounded logs. Only the panel
port is published; `/api/` is proxied to the API on the container network.

Copy `.env.example` to `.env` and retain its restrictive file permissions (`600`).
Set `RAIDEN_IMAGE_TAG`, a random URL-safe `POSTGRES_PASSWORD` (hex is suitable),
`PANEL_BIND_ADDRESS`, and `PANEL_PORT`. Preserve `BOOT_SETTINGS_ENCRYPTION_KEY`
when restoring a database containing encrypted runtime settings. Telegram tokens,
API keys, database backups, passwords, and the real `.env` must stay out of Git.

Build on the same architecture as the server (or use an explicit target platform):

```sh
docker build -f packages/bot/Dockerfile -t raiden-node:RELEASE .
docker build -f services/embedding/Dockerfile -t raiden-embedding:RELEASE .
docker build --build-arg VITE_API_BASE_URL=/ -f packages/panel/Dockerfile -t raiden-panel:RELEASE .
```

Transfer these images and the matching `pgvector/pgvector:pg17` and
`redis/redis-stack-server:7.4.0-v8` images with `docker save` / `docker load`
if no registry is used. Set `RAIDEN_IMAGE_TAG=RELEASE` in the server `.env`.

```sh
docker-compose --env-file .env -p raiden -f deploy/compose.yml up -d
docker-compose --env-file .env -p raiden -f deploy/compose.yml ps
docker-compose --env-file .env -p raiden -f deploy/compose.yml logs --tail=100 bot bot-worker
```

`docker compose` (v2) may be used in place of `docker-compose`. For a fresh
database, initialize an administrator with `ADMIN_USERNAME` / `ADMIN_PASSWORD`
and `docker-compose ... exec api pnpm admin:bootstrap`. When migrating an existing
installation, restore PostgreSQL (including runtime settings, administrators,
chat approvals and memories) and Redis jobs before starting application services.
Copy the embedding model cache to avoid a first-start download. Stop the old bot
and workers before the final snapshots, and keep only one polling instance active.

For LAN HTTP access, use `ADMIN_SECURE_COOKIES=false` and leave `NODE_ENV` unset;
the server forces secure cookies when `NODE_ENV=production`. Set
`CORS_ALLOWED_ORIGINS` to the panel origin. For public access, terminate HTTPS and
enable secure cookies. The panel image must use `VITE_API_BASE_URL=/` for this
same-origin proxy configuration.

Back up PostgreSQL with `pg_dump -Fc` and Redis with `redis-cli SAVE` plus a copy
of `/data`. Store backups with mode `600`. Never use `down -v` when retaining data.
