# Fix React Version Mismatch

## Problem
React version mismatch error:
- `react: 19.2.3` (installed)
- `react-native-renderer: 19.1.0` (required by React Native/Expo SDK 54)

## Solution

The `package.json` has been updated to pin React to exactly `19.1.0` (removed the `^` caret). You need to reinstall dependencies to apply the fix:

### Option 1: Clean Install (Recommended)

```bash
cd mobile
rm -rf node_modules package-lock.json
npm install
```

### Option 2: Force Reinstall

```bash
cd mobile
npm install --force
```

### Option 3: If npm install fails with permissions

If you get permission errors, try:

```bash
cd mobile
sudo rm -rf node_modules package-lock.json
npm install
```

Or run without sudo (safer):

```bash
cd mobile
# Manually delete node_modules and package-lock.json in Finder/Explorer
npm install
```

## Verify Fix

After reinstalling, verify the React version:

```bash
cd mobile
npm list react
```

Should show: `react@19.1.0`

## Restart Expo

After fixing, restart Expo:

```bash
cd mobile
npm start -- --clear
```

The `--clear` flag clears the Metro bundler cache.
