# Deployment

The supported deployment path is a git checkout plus `docker compose build`.
No image is pulled from a registry we publish to, and the target server needs
nothing but Docker and Git (`PLAN.md` Gate H, Gate I, section 36).

## A note on `--env-file`

Compose resolves its project directory from the first `-f` file, so a `.env` at
the repository root is **not** picked up automatically when the compose files
live under `deployments/compose/`. Every documented command therefore passes
`--env-file .env` explicitly. The `scripts/*.sh` wrappers do this for you.

## Fresh installation

```bash
git clone <repository>
cd squid-control-plane
git checkout v1.0.0

cp .env.example .env
```

Fill in the required secrets:

```bash
openssl rand -base64 32   # JWT_SECRET
openssl rand -base64 32   # SECRET_ENCRYPTION_KEY
```

Also set `POSTGRES_PASSWORD`, keep `DATABASE_URL` in sync with it, and set
`BOOTSTRAP_ADMIN_PASSWORD` for the first administrator.

Then either run the wrapper:

```bash
./scripts/install.sh
```

or the same steps by hand:

```bash
docker compose --env-file .env \
  -f deployments/compose/compose.yml \
  -f deployments/compose/compose.prod.yml build

docker compose --env-file .env \
  -f deployments/compose/compose.yml \
  -f deployments/compose/compose.prod.yml run --rm migrate

docker compose --env-file .env \
  -f deployments/compose/compose.yml \
  -f deployments/compose/compose.prod.yml up -d --remove-orphans
```

Verify:

```bash
curl -fsS http://localhost:8080/api/health/ready
./scripts/healthcheck.sh
```

Sign in at `http://<host>:8080` with `BOOTSTRAP_ADMIN_USERNAME` and change the
password immediately (the UI marks the account until you do).

## Development

```bash
docker compose --env-file .env \
  -f deployments/compose/compose.yml \
  -f deployments/compose/compose.dev.yml up --build
```

Web with hot reload on <http://localhost:5173>, API on <http://localhost:3000>,
PostgreSQL on `127.0.0.1:5432`. Source directories are mounted, so edits apply
without a rebuild.

## Update

```bash
git fetch --tags
git checkout v1.1.0

./scripts/backup.sh
./scripts/update.sh
```

`update.sh` builds, migrates and restarts. Migrations are forward-only: each
file runs once and is recorded with its checksum, so an edited migration is
detected instead of silently diverging.

## Rollback

Application rollback is a git operation:

```bash
git checkout v1.0.0

docker compose --env-file .env \
  -f deployments/compose/compose.yml \
  -f deployments/compose/compose.prod.yml build

docker compose --env-file .env \
  -f deployments/compose/compose.yml \
  -f deployments/compose/compose.prod.yml up -d
```

Because migrations are forward-only, an older application version only works
against a newer schema when the release notes say so. Every release therefore
documents:

```text
Application rollback supported:  YES / NO
Minimum database schema:         <migration filename>
```

If a rollback crosses an incompatible schema change, restore the backup taken
before the update instead.

## Backup and restore

```bash
./scripts/backup.sh                 # writes ./backups/squidcp-<timestamp>.sql.gz
./scripts/restore.sh backups/squidcp-20260816T101500Z.sql.gz
```

The dump contains password hashes and encrypted provider secrets. Provider
secrets are encrypted with `SECRET_ENCRYPTION_KEY`, which lives in `.env` and
**not** in the database: back up `.env` separately, store it elsewhere, and
never rotate the key without re-entering the affected provider credentials.

## Network layout

```text
frontend   web  <-> api
backend    api  <-> redis
database   api  <-> postgres
```

Only the web entrypoint publishes a host port. PostgreSQL and Redis have no
port mapping in any compose file, in production or development (except the
loopback-bound convenience mapping in the dev overlay).

## Putting TLS in front

Node agents are machine clients. Bot protection and managed WAF rules in front
of the control plane block them, and the agent then fails to enrol with a `403`
that never reached the API. Exclude `/api/v1/agent/` from those protections -
that prefix only, since the agent endpoints carry their own `X-Agent-Key`
credential while the rest of the API should stay protected.

The stack terminates plain HTTP on `WEB_PORT`. Put a reverse proxy (nginx,
Caddy, Traefik) in front for TLS. The API reads `X-Forwarded-For`, so client
addresses in the audit log stay correct as long as the proxy sets it.

## Build metadata

`APP_VERSION`, `GIT_SHA` and `BUILD_DATE` are passed as build arguments, become
OCI image labels, and are served by `/api/health/version`. The deployment
scripts derive them from the checkout, so what the UI reports under
`System → Settings` is what is actually deployed.
