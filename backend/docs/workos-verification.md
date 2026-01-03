# WorkOS Integration Verification Guide

## Current Status

The WorkOS integration code has been implemented, but needs to be verified and tested. Follow these steps to ensure everything is working.

## Step 1: Install Dependencies

```bash
cd backend
npm install
```

This will install the `@workos-inc/node` package that was added to `package.json`.

**Expected**: Should complete without errors and install WorkOS SDK.

## Step 2: Regenerate Prisma Client

The Prisma schema was updated to include `workosUserId` field, but the Prisma client needs to be regenerated:

```bash
npm run prisma:generate
```

**Expected**: Prisma client regenerated with new User model fields.

## Step 3: Run Database Migration

Update the database schema to match the Prisma schema changes:

```bash
npm run prisma:migrate
```

**Expected**: Migration creates/updates User table with:
- `workosUserId` field (nullable, unique)
- `emailVerified` field
- Removes `password` field
- Removes `RefreshToken` table

## Step 4: Type Check

Verify TypeScript compilation:

```bash
npm run type-check
```

**Expected**: No TypeScript errors. All WorkOS-related code should compile.

## Step 5: Set Up WorkOS Account (Required for Testing)

1. **Create WorkOS Account**: https://workos.com
2. **Create Project** in WorkOS dashboard
3. **Get Credentials**:
   - API Key (starts with `sk_test_` or `sk_live_`)
   - Client ID (starts with `client_`)
4. **Configure Redirect URI**:
   - In WorkOS dashboard → Configuration → Redirect URIs
   - Add: `http://localhost:3000/api/v1/auth/callback`

## Step 6: Update Environment Variables

Add to `backend/.env`:

```env
WORKOS_API_KEY="sk_test_..."
WORKOS_CLIENT_ID="client_..."
WORKOS_ENVIRONMENT="sandbox"
WORKOS_REDIRECT_URI="http://localhost:3000/api/v1/auth/callback"
```

## Step 7: Test the Integration

### 7a. Start the Server

```bash
npm run dev
```

**Expected**: Server starts without errors. If WorkOS env vars are missing, you'll get an error (which is expected).

### 7b. Test Login Endpoint (Once WorkOS is Configured)

1. Open browser: `http://localhost:3000/api/v1/auth/login`
2. Should redirect to WorkOS login page
3. After login, redirects back to callback
4. Should return JSON with user info and access token

### 7c. Test Protected Endpoint

```bash
# Use the access token from login response
curl -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  http://localhost:3000/api/v1/auth/me
```

**Expected**: Returns current user information.

## Verification Checklist

- [ ] `npm install` completes successfully
- [ ] `npm run prisma:generate` completes successfully
- [ ] `npm run prisma:migrate` completes successfully
- [ ] `npm run type-check` passes (no errors)
- [ ] WorkOS account created and credentials obtained
- [ ] Environment variables set in `.env`
- [ ] Server starts without errors
- [ ] Login endpoint redirects to WorkOS (when credentials are set)
- [ ] Callback endpoint works (when credentials are set)
- [ ] Protected endpoint works with valid token

## Common Issues

### TypeScript Errors About `workosUserId`

**Problem**: TypeScript can't find `workosUserId` field  
**Solution**: Run `npm run prisma:generate` to regenerate Prisma client

### WorkOS Client Initialization Error

**Problem**: "WORKOS_API_KEY environment variable is required"  
**Solution**: Add WorkOS credentials to `.env` file

### Database Migration Fails

**Problem**: Migration can't remove password field  
**Solution**: May need to manually handle existing data. Check migration file.

### Module Not Found: @workos-inc/node

**Problem**: WorkOS package not installed  
**Solution**: Run `npm install` in backend directory

## Next Steps After Verification

Once verified:
1. Test full authentication flow
2. Integrate with mobile app
3. Add role-based access control tests
4. Set up production WorkOS environment

## Manual Testing Without WorkOS Account

If you don't have WorkOS credentials yet, you can still verify:

1. ✅ Code compiles (`npm run type-check`)
2. ✅ Prisma client regenerates (`npm run prisma:generate`)
3. ✅ Database migration runs (`npm run prisma:migrate`)
4. ❌ Full auth flow requires WorkOS account

The code structure is correct; you just need WorkOS credentials to test the actual authentication flow.
