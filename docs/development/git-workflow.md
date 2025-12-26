# Git Workflow Guide

## Branch Strategy

We use a **feature branch workflow** with the following branches:

- **`main`**: Production-ready code (protected)
- **`develop`**: Integration branch for completed features
- **`feature/*`**: Feature development branches
- **`fix/*`**: Bug fix branches

## Workflow

### Starting a New Feature

1. **Ensure you're on `develop` and it's up to date:**
   ```bash
   git checkout develop
   git pull origin develop
   ```

2. **Create a feature branch:**
   ```bash
   git checkout -b feature/your-feature-name
   ```

3. **Work on your feature and commit regularly:**
   ```bash
   git add .
   git commit -m "feat: description of changes"
   ```

4. **When feature is complete, merge back to `develop`:**
   ```bash
   git checkout develop
   git merge feature/your-feature-name
   git push origin develop
   ```

### Working on Multiple Features

You can work on multiple feature branches in parallel:

```bash
# Work on backend feature
git checkout -b feature/backend-auth
# ... make changes and commit

# Switch to mobile feature
git checkout -b feature/mobile-app-init
# ... make changes and commit

# Switch back to backend
git checkout feature/backend-auth
```

Each feature branch is independent and can be worked on separately.

### Committing Work

**Best Practice:** Commit work incrementally as you complete logical units:

- ✅ Commit backend setup when it's working
- ✅ Commit mobile setup when it's working
- ✅ Commit each feature as it's completed

**Why?**
- Easier to review changes
- Easier to roll back if needed
- Better git history
- Can share work with others incrementally

## Current Situation

For the backend work we just completed:

1. **Option A (Recommended):** Commit backend to `develop` first
   ```bash
   git checkout develop
   git add backend/ docs/
   git commit -m "feat: backend initialization with Express, Prisma, and tests"
   git push origin develop
   
   # Then continue mobile work on feature branch
   git checkout feature/mobile-app-init
   ```

2. **Option B:** Commit backend work to the mobile branch
   - Less ideal, but works if you want to keep everything together
   - You can always reorganize later with interactive rebase

## Merging Strategy

When ready to merge a feature:

1. Ensure feature branch is up to date with `develop`
2. Merge to `develop` (or create PR if using GitHub)
3. Test on `develop`
4. When `develop` is stable, merge to `main` for releases

## Example: Current Project

```
main
  └── develop (has initial setup)
       ├── feature/mobile-app-init (you are here)
       └── (backend work uncommitted)
```

**Recommended next steps:**
1. Commit backend work to `develop`
2. Continue mobile work on `feature/mobile-app-init`
3. Later merge mobile branch back to `develop`

