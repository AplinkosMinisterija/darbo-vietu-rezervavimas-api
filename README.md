# stalu-rezervavimas-api

Stalų rezervavimo sistemos backend — Moleculer.js + TypeScript microservices,
PostgreSQL, Microsoft OAuth (Entra ID) prisijungimas. Dalis biip ekosistemos
(Aplinkos ministerija).

## Stack

- **Runtime:** Node.js 18 + TypeScript (strict)
- **Microservices:** Moleculer.js + moleculer-web (HTTP gateway)
- **Database:** PostgreSQL + Knex (migracijos) + Objection (ORM) + @moleculer/database
- **Auth:** Microsoft OAuth (`@azure/msal-node`), HttpOnly+Secure+SameSite=Strict
  cookies, JWT (HS512) — 8h sesija
- **Container:** Docker, deploy per biip-infra

## Repo'ų sąrašas

| Repo | Funkcija |
|---|---|
| `stalu-rezervavimas-api` (šis) | Moleculer.js backend |
| `stalu-rezervavimas-web` | React + Vite frontend |
| `biip-infra` | docker-compose, Caddy, deploy workflow'ai |

## Spec

Pilnas dizaino dokumentas (auth flow, data model, endpoint'ai, infra) —
[`../stalu-rezervavimas/docs/superpowers/specs/2026-05-28-stalu-rezervavimas-design.md`](../stalu-rezervavimas/docs/superpowers/specs/2026-05-28-stalu-rezervavimas-design.md).

## Local dev setup

### 1. Postgres

Greičiausia per Docker:

```bash
docker run -d --name stalu-postgres \
  -e POSTGRES_USER=stalu \
  -e POSTGRES_PASSWORD=stalu \
  -e POSTGRES_DB=stalu_dev \
  -p 5432:5432 \
  postgres:15
```

Arba per biip-infra `docker-compose up postgres`.

### 2. Env

```bash
cp .env.example .env
# Pakeisk OUTLOOK_CLIENT_ID/SECRET/TENANT su realiomis Azure reikšmėmis
# (IT admin pateiks po app registration sukūrimo).
```

### 3. Install + migrate + run

```bash
yarn install
yarn db:migrate          # Knex migracijos
yarn dev                 # moleculer-runner --hot --repl
```

Health check:

```bash
curl http://localhost:3000/api/health
# → { "status": "ok", "ts": <epoch> }
```

## Skriptai

| Skriptas | Aprašymas |
|---|---|
| `yarn dev` | Dev režimas su hot reload + REPL |
| `yarn build` | TypeScript → dist/ |
| `yarn start` | Production (po `yarn build`) |
| `yarn db:migrate` | Knex migrate latest |
| `yarn db:rollback` | Knex rollback last batch |
| `yarn db:seed` | Knex seed run |
| `yarn lint` | ESLint |

## Phase plan

1. **Phase 0 (šis scaffold)** — repo struktūra, health endpoint, build green.
2. **Phase 1** — DB migracijos (`users`, `rooms`, `user_room_assignments`,
   `reservations`, `audit_log`), auth flow (Microsoft OAuth), users.service.
3. **Phase 2** — rooms.service, reservations.service (su unique constraint'ais).
4. **Phase 3** — admin.service (stats, audit), seed migracijos iš prototipo.
5. **Phase 4** — frontend integracija.
6. **Phase 5** — biip-infra wiring (Caddy, docker-compose, env).
7. **Phase 6** — CI/CD (.github/workflows).

## Saugumo principai (iš biip-alis-api lessons)

- `JWT_SECRET` per `utils/auth.ts:getJwtSecret()` — fail-fast prod'e jei
  placeholder ar unset.
- JWT algorithm pinned (`JWT_ALGORITHM` konstanta) — abu `sign` ir `verify`
  jį naudoja.
- `requireAdminHook` Moleculer `before` hook tikrinant ROLE_ADMIN per
  `ctx.meta.user.role` — netinka pasitikėti `auth: true` vien.
- CORS origin'ai per `CORS_ORIGINS` env (comma-separated), niekada
  `origin: '*'`.
- Cookies: `HttpOnly`, `Secure` (prod), `SameSite=Strict`, `Path=/`.
- Body parser limit 2MB.
- `onError` produkcijoje grąžina generic 5xx žinutę, ne `err.message`.
