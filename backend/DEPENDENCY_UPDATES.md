# Dependency Updates

## Changes Made

Based on npm deprecation warnings, we've updated the following dependencies:

### Updated Dependencies

1. **supertest**: `^6.3.3` → `^7.1.3`
   - ✅ Fixed deprecation warning
   - Latest stable version

2. **eslint**: Kept at `^8.57.0` (latest ESLint 8)
   - ⚠️ ESLint 8 is deprecated but still functional
   - ESLint 9 requires typescript-eslint v8+, which has compatibility issues
   - Will upgrade to ESLint 9 when typescript-eslint fully supports it

3. **@typescript-eslint packages**: Updated to `^7.18.0`
   - Compatible with ESLint 8
   - Latest stable version for ESLint 8

### Configuration

- **ESLint Config**: Using `.eslintrc.json` (ESLint 8 format)
  - ESLint 9 would require flat config, but staying on ESLint 8 for compatibility

### Transitive Dependencies

The following deprecation warnings are from transitive dependencies (dependencies of our dependencies):
- `inflight@1.0.6` - Will be resolved when parent packages update
- `rimraf@3.0.2` - Will be resolved when parent packages update
- `glob@7.2.3` - Will be resolved when parent packages update
- `superagent@8.1.2` - Will be resolved when parent packages update
- `@humanwhocodes/*` packages - Replaced by `@eslint/*` packages in ESLint v9

These will be automatically updated when the packages that depend on them are updated.

## Next Steps

After updating `package.json`, run:

```bash
npm install
```

This will install the updated versions and resolve the deprecation warnings for packages we control directly.

## Testing

After updating, verify everything still works:

```bash
npm run lint
npm run type-check
npm test
```

