# WorkOS Integration Testing Checklist

## ✅ Server Startup
- [x] Server starts without errors
- [ ] Server logs show it's running on port 3000
- [ ] Environment variables are loaded correctly

## 1. Basic Server Health

### Test: Health Check Endpoint
```bash
curl http://localhost:3000/health
```

**Expected Result:**
```json
{
  "status": "ok",
  "timestamp": "2025-12-30T..."
}
```

### Test: API Root Endpoint
```bash
curl http://localhost:3000/api/v1
```

**Expected Result:**
```json
{
  "message": "API v1"
}
```

## 2. WorkOS Authentication Flow

### Test: Login Endpoint (Redirects to WorkOS)
Open in browser or use curl with redirect following:
```bash
# Browser (recommended)
http://localhost:3000/api/v1/auth/login

# Or curl (will show redirect)
curl -L http://localhost:3000/api/v1/auth/login
```

**Expected Result:**
- Should redirect to WorkOS login page
- URL should be something like: `https://api.workos.com/sso/authorize?...`
- If you see WorkOS login page, authentication setup is working!

**If you see an error:**
- Check that `WORKOS_CLIENT_ID` is correct in `.env`
- Check that redirect URI is configured in WorkOS dashboard
- Verify `WORKOS_REDIRECT_URI` in `.env` matches WorkOS dashboard

### Test: Callback Endpoint (After Login)
This will be called automatically by WorkOS after login, but you can test the endpoint structure:

```bash
# This will fail without a valid code, but should show proper error handling
curl http://localhost:3000/api/v1/auth/callback?code=invalid
```

**Expected Result:**
- Should return an error (since code is invalid)
- Error should be properly formatted JSON
- Should NOT crash the server

### Test: Protected Endpoint (Requires Token)
```bash
# Without token (should fail)
curl http://localhost:3000/api/v1/auth/me

# With invalid token (should fail)
curl -H "Authorization: Bearer invalid_token" http://localhost:3000/api/v1/auth/me
```

**Expected Result:**
- Should return 401 Unauthorized
- Should have proper error message

## 3. Full Authentication Flow Test

### Step-by-Step Browser Test:

1. **Start the server:**
   ```bash
   npm run dev
   ```

2. **Open login URL in browser:**
   ```
   http://localhost:3000/api/v1/auth/login
   ```

3. **Expected flow:**
   - Browser redirects to WorkOS login page
   - Sign in with your WorkOS account (or create one)
   - WorkOS redirects back to: `http://localhost:3000/api/v1/auth/callback?code=...`
   - You should see a JSON response with:
     ```json
     {
       "success": true,
       "user": {
         "id": "...",
         "email": "your@email.com",
         "name": "Your Name",
         "role": "PLAYER"
       },
       "accessToken": "workos_access_token_here"
     }
     ```

4. **Test protected endpoint with token:**
   ```bash
   # Copy the accessToken from the response above
   curl -H "Authorization: Bearer YOUR_ACCESS_TOKEN_HERE" \
     http://localhost:3000/api/v1/auth/me
   ```

   **Expected Result:**
   ```json
   {
     "id": "...",
     "email": "your@email.com",
     "name": "Your Name",
     "role": "PLAYER"
   }
   ```

## 4. Database Verification

After successful login, check that user was created in database:

```bash
# Using Prisma Studio
npm run prisma:studio
```

Then check the `User` table:
- Should have a new user with your email
- `workosUserId` should be populated
- `emailVerified` should be `true` (if WorkOS verified it)

## 5. Common Issues & Solutions

### Issue: "Redirect URI mismatch"
**Solution:** 
- Check WorkOS dashboard → Configuration → Redirect URIs
- Must exactly match: `http://localhost:3000/api/v1/auth/callback`
- Check `.env` file has correct `WORKOS_REDIRECT_URI`

### Issue: "Invalid client ID"
**Solution:**
- Verify `WORKOS_CLIENT_ID` in `.env` matches WorkOS dashboard
- Make sure you're using the Client ID (starts with `client_`), not API key

### Issue: "WORKOS_API_KEY environment variable is required"
**Solution:**
- Check `.env` file exists in `backend/` directory
- Verify `WORKOS_API_KEY` is set (starts with `sk_test_` or `sk_live_`)
- Restart the server after updating `.env`

### Issue: Server crashes on callback
**Solution:**
- Check database is running: `docker-compose ps`
- Verify Prisma migrations are up to date: `npm run prisma:migrate`
- Check server logs for specific error

## 6. Next Steps After Successful Test

Once authentication is working:
- ✅ Backend authentication is ready
- ✅ Mobile app can integrate with WorkOS
- ✅ Protected routes can use authentication middleware
- ✅ Ready to build mobile app login flow
