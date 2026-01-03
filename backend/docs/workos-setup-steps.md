# WorkOS Setup - Step-by-Step Guide

## Step 1: Create WorkOS Account

1. Go to https://workos.com
2. Click **"Sign Up"** or **"Get Started"**
3. Sign up with your email (or use Google/GitHub if available)
4. Verify your email if required

## Step 2: Create a Project

1. After logging in, you'll be in the WorkOS Dashboard
2. Click **"Create Project"** or **"New Project"**
3. Enter project name: `Basketball Tracker` (or any name you prefer)
4. Click **"Create"**

## Step 3: Get Your API Key

1. In your project dashboard, navigate to **"API Keys"** in the sidebar
2. You'll see a default API key (starts with `sk_test_` for sandbox)
3. Click **"Copy"** or **"Show"** to reveal the key
4. **Save this key** - you'll need it for your `.env` file

**Note**: For development, use the test key (`sk_test_...`). For production, create a live key (`sk_live_...`).

## Step 4: Get Your Client ID

1. In the same project dashboard, go to **"Configuration"** → **"Client IDs"**
2. You should see a default Client ID (starts with `client_`)
3. Click **"Copy"** to copy the Client ID
4. **Save this ID** - you'll need it for your `.env` file

## Step 5: Configure Redirect URI

1. Still in **"Configuration"**, go to **"Redirect URIs"**
2. Click **"Add Redirect URI"**
3. Enter: `http://localhost:3000/api/v1/auth/callback`
4. Click **"Save"** or **"Add"**

**Important**: This must match exactly what's in your `.env` file.

## Step 6: Configure Email/Password Authentication

**GOOD NEWS**: For email/password authentication using WorkOS AuthKit, you can use the `authkit` provider - no Connection setup required!

### Option 1: Use AuthKit Provider (Recommended for Email/Password)

This is the simplest approach for email/password authentication:

1. In your `.env` file, set:
   ```env
   WORKOS_PROVIDER="authkit"
   ```

2. That's it! The code will automatically use `provider: "authkit"` if no other connection/organization/provider is set.

This enables WorkOS AuthKit's default email/password authentication flow. Users can sign up and sign in with email and password.

**Reference**: [WorkOS AuthKit Authentication Documentation](https://workos.com/docs/reference/authkit/authentication)

### Option 2: Create a Connection (For Custom Auth Methods)

If you want to use specific authentication methods like Magic Link or OTP:

1. In WorkOS dashboard, navigate to **"User Management"** in the left sidebar
2. Click on **"Connections"** (or look for a "Connections" tab/section)
3. Click **"Create Connection"** or **"Add Connection"** button
4. Select your preferred authentication method:
   - **"Email Magic Link"** - Passwordless, sends magic link to email
   - **"Email OTP"** - Passwordless, sends one-time code to email  
   - **"Email/Password"** - Traditional email and password (if available)
5. Give it a name (e.g., "Basketball Tracker Email Auth")
6. Click **"Create"** or **"Save"**
7. **Copy the Connection ID** - it will start with `conn_` (e.g., `conn_01ABC123...`)
8. Add `WORKOS_CONNECTION_ID="conn_..."` to your `.env` file

## Step 7: Update Your .env File

Open `backend/.env` and update these values:

### For Email/Password Authentication (Recommended)

```env
WORKOS_API_KEY="sk_test_YOUR_API_KEY_HERE"
WORKOS_CLIENT_ID="client_YOUR_CLIENT_ID_HERE"
WORKOS_ENVIRONMENT="sandbox"
WORKOS_REDIRECT_URI="http://localhost:3000/api/v1/auth/callback"
WORKOS_PROVIDER="authkit"
# Leave these empty (not needed for basic email/password):
# WORKOS_CONNECTION_ID=""
# WORKOS_ORGANIZATION_ID=""
```

**Important**: 
- ✅ **For email/password auth**: Set `WORKOS_PROVIDER="authkit"` (simplest approach)
- ✅ The code will default to `authkit` if nothing is set, but it's better to be explicit
- ❌ Don't set `WORKOS_CONNECTION_ID` unless you created a custom connection (Option 2 in Step 6)
- ❌ Don't set `WORKOS_ORGANIZATION_ID` unless you're using enterprise SSO

### Alternative: Using a Connection ID

If you created a Connection in Step 6 (Option 2):

```env
WORKOS_API_KEY="sk_test_YOUR_API_KEY_HERE"
WORKOS_CLIENT_ID="client_YOUR_CLIENT_ID_HERE"
WORKOS_ENVIRONMENT="sandbox"
WORKOS_REDIRECT_URI="http://localhost:3000/api/v1/auth/callback"
WORKOS_CONNECTION_ID="conn_YOUR_CONNECTION_ID_HERE"
# Leave these empty:
# WORKOS_ORGANIZATION_ID=""
# WORKOS_PROVIDER=""
```

Replace the values with the actual ones from Steps 3, 4, and 6.

## Step 8: Run Database Migration (if needed)

If you haven't run the migration yet:

```bash
cd backend
npm run prisma:migrate
```

This will ensure your database schema matches the Prisma schema (which already has WorkOS fields).

## Step 9: Verify Setup

Run the verification script:

```bash
cd backend
./scripts/verify-workos.sh
```

Or manually check:
- All environment variables are set
- WorkOS client initializes correctly
- Database schema is up to date

## Step 10: Test the Integration

1. Start your backend server:
   ```bash
   cd backend
   npm run dev
   ```

2. Open your browser and go to:
   ```
   http://localhost:3000/api/v1/auth/login
   ```

3. You should be redirected to WorkOS login page
4. Sign in (or create an account if first time)
5. You'll be redirected back to your callback URL
6. Check the response - you should see user info and an access token

## Troubleshooting

### "WORKOS_API_KEY environment variable is required"
- Make sure your `.env` file is in the `backend/` directory
- Check that the variable name is exactly `WORKOS_API_KEY`
- Restart your server after updating `.env`

### "organization_invalid" Error
- ❌ **You're using `WORKOS_ORGANIZATION_ID` for email/password auth** - this is wrong!
- ✅ **Solution**: Remove `WORKOS_ORGANIZATION_ID` from your `.env` file
- ✅ **For email/password**: Don't set `WORKOS_CONNECTION_ID` either - leave it empty!
- ✅ Email/password authentication works by default without any connection/organization
- Organizations are ONLY for enterprise SSO, not consumer email/password auth

### "Invalid redirect URI"
- Make sure the redirect URI in WorkOS dashboard matches exactly: `http://localhost:3000/api/v1/auth/callback`
- For mobile apps, also add: `bball-tracker://auth/callback`
- Check that it's added in the WorkOS Configuration → Redirect URIs section

### "Client ID not found"
- Verify your `WORKOS_CLIENT_ID` in `.env` matches the Client ID in WorkOS dashboard
- Make sure you're using the Client ID (starts with `client_`), not the API key

### "No connections are available" or "Connection not found"
- **For email/password auth**: You don't need a Connection! Leave `WORKOS_CONNECTION_ID` empty
- Only create a Connection if you want SSO or OAuth (Google, Microsoft, etc.)
- Make sure email/password is enabled in WorkOS dashboard: User Management → Authentication

### Database errors
- Make sure PostgreSQL is running: `docker-compose up -d` (if using Docker)
- Run migrations: `npm run prisma:migrate`
- Regenerate Prisma client: `npm run prisma:generate`

## Next Steps

Once WorkOS is set up and tested:
1. ✅ Backend authentication is ready
2. ✅ Mobile app can integrate with WorkOS
3. ✅ Protected routes can use authentication middleware
