# Release Strategy

## Branch Purpose

- **`main`**: Production-ready, stable code that could be deployed
- **`develop`**: Active development, integration of features

## When to Merge to Main

### Recommended Approach

Merge `develop` → `main` when you reach **milestones**:

1. **Initial Setup Complete** (Current milestone)
   - ✅ Project structure
   - ✅ Backend foundation
   - ✅ Basic documentation
   - **Status**: Ready to merge to `main` ✅

2. **MVP Ready** (Future milestone)
   - Backend APIs working
   - Mobile app can connect to backend
   - Basic features functional
   - **Status**: Ready for first release

3. **Feature Complete** (Future milestone)
   - All core features implemented
   - Tested and stable
   - **Status**: Ready for v1.0.0

## Current Recommendation

**Yes, push `develop` to GitHub now:**
- You have completed backend initialization
- It's a logical checkpoint
- Good for backup and collaboration

**Consider merging to `main` when:**
- You have a few more features complete (mobile app setup, basic APIs)
- OR when you want to tag your first release
- OR when you're ready to deploy something

## Typical Release Cycle

```
1. Work on features → develop
2. Test on develop
3. When stable → merge to main
4. Tag release: git tag -a v0.1.0
5. Continue development on develop
```

## For Open Source Projects

- `main` should always be in a deployable state
- Anyone cloning the repo should get working code
- Releases are tagged from `main`
- `develop` can be "work in progress"

