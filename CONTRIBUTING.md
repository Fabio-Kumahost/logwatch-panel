# Contributing to LogWatch Panel

Thanks for your interest in improving LogWatch! Contributions of all kinds are
welcome — bug reports, features, docs, tests.

## Development setup

```bash
# Panel (Node.js >= 20)
cd panel
npm install
npm test                      # 26 smoke tests, must stay green
DB_PATH=./data/dev.db ADMIN_USER=admin ADMIN_PASS='dev12345' node src/db/migrate.js --seed-admin
PUBLIC_URL=http://localhost:8088 npm start   # http://localhost:8088

# Agent (Go >= 1.21)
make agent-all                # cross-compile into agent-bin/
( cd agent && GOOS=linux go vet ./... )
```

## Ground rules

- **Tests must pass** (`npm test`) and **`go vet` must be clean** before a PR.
  Add a test for every bug fix and feature touching the backend.
- Keep the agent **standard-library only** (no third-party Go modules).
- Keep the frontend **dependency-free** vanilla JS (no build step).
- Validate all input at the API boundary (zod) and use parameterized SQL only.
- Never commit secrets, `.env`, or the database.
- Bump the panel version in `panel/package.json` and the `?v=` asset query when
  you change frontend assets (cache busting), and add a `CHANGELOG.md` entry.

## Commit & PR

- Use clear, conventional commit messages (`fix:`, `feat:`, `docs:`…).
- Describe the user-facing effect and how you tested it in the PR body.
- One logical change per PR where possible.

## Reporting security issues

Please **do not** open a public issue for vulnerabilities — see [SECURITY.md](SECURITY.md).
