# Git Workflow Guide

## Branch Strategy

There is **one long-lived branch: `main`** (protected). There is no `develop`
branch. All work happens on short-lived branches cut from `main` and merged back
through a pull request.

- **`main`** — production-ready code. Every merge to `main` that touches
  `backend/` is auto-deployed to ECS by CI (`.github/workflows/ci.yml`).
- **`feature/*`** — new functionality
- **`fix/*`** — bug fixes
- **`docs/*`** — documentation-only changes
- **`chore/*`** — dependency bumps, tooling

## Workflow

1. **Start from an up-to-date `main`:**
   ```bash
   git checkout main
   git pull origin main
   git checkout -b feature/your-feature-name
   ```

2. **Commit with [Conventional Commits](https://www.conventionalcommits.org/)**
   (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`), scoped when it
   helps (`feat(mobile): …`, `fix(auth): …`):
   ```bash
   git add -p
   git commit -m "feat(teams): add staff management screen"
   ```

3. **Keep docs in the same change.** If behaviour, APIs, schema, env vars,
   commands or ops steps change, update `CLAUDE.md` / `docs/` in the same PR.
   The committed Stop hook (`.claude/hooks/check-docs-updated.sh`) reminds you
   when code changed without a docs update.

4. **Before pushing**, run the package checks for everything you touched:
   ```bash
   cd backend && npm run lint && npm run type-check && npm test
   cd mobile  && npm run lint && npm run type-check && npm test
   cd web     && npm run lint && npm run build
   ```
   Lint runs with `--max-warnings 0` in CI — warnings fail the build.

5. **Open a PR against `main`:**
   ```bash
   git push -u origin feature/your-feature-name
   gh pr create --fill
   gh pr checks <n> --watch
   ```
   Required checks: lint / type-check / Jest for backend and mobile, the Metro
   `expo export` smoke build, and CodeQL.

6. **Merge with squash and delete the branch:**
   ```bash
   gh pr merge <n> --squash --delete-branch
   ```

## Tagging releases

Tag `main` when a notable milestone lands (new feature set, design overhaul,
large refactor) using semantic versioning:

```bash
git tag -a v1.2.0 -m "Team staff management + PARENT role"
git push origin v1.2.0
```

- **Major** (vX.0.0): breaking changes / architectural rewrites
- **Minor** (v0.X.0): new features, significant improvements
- **Patch** (v0.0.X): bug fixes, small tweaks

See [`release-strategy.md`](./release-strategy.md) for how backend deploys and
mobile builds/OTA updates relate to `main`.

## Automation on `main`

- **Dependabot** PRs (patch/minor bumps) are auto-merged by
  `.github/workflows/dependabot-auto-merge.yml` once CI passes.
- The **Daily Upgrade Scan** (`.github/workflows/daily-upgrade-scan.yml`) opens
  PRs for vulnerable transitives and mobile lockfile-only bumps — see
  [`docs/automation/daily-upgrade-scan.md`](../automation/daily-upgrade-scan.md).
