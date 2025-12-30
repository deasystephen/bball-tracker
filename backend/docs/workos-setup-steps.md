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

## Step 6: Update Your .env File

Open `backend/.env` and update these values:

```env
WORKOS_API_KEY="sk_test_YOUR_API_KEY_HERE"
WORKOS_CLIENT_ID="client_YOUR_CLIENT_ID_HERE"
WORKOS_ENVIRONMENT="sandbox"
WORKOS_REDIRECT_URI="http://localhost:3000/api/v1/auth/callback"
```

Replace `YOUR_API_KEY_HERE` and `YOUR_CLIENT_ID_HERE` with the actual values from Steps 3 and 4.

## Step 7: Run Database Migration (if needed)

If you haven't run the migration yet:

```bash
cd backend
npm run prisma:migrate
```

This will ensure your database schema matches the Prisma schema (which already has WorkOS fields).

## Step 8: Verify Setup

Run the verification script:

```bash
cd backend
./scripts/verify-workos.sh
```

Or manually check:
- All environment variables are set
- WorkOS client initializes correctly
- Database schema is up to date

## Step 9: Test the Integration

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

### "Invalid redirect URI"
- Make sure the redirect URI in WorkOS dashboard matches exactly: `http://localhost:3000/api/v1/auth/callback`
- Check that it's added in the WorkOS Configuration → Redirect URIs section

### "Client ID not found"
- Verify your `WORKOS_CLIENT_ID` in `.env` matches the Client ID in WorkOS dashboard
- Make sure you're using the Client ID (starts with `client_`), not the API key

### Database errors
- Make sure PostgreSQL is running: `docker-compose up -d` (if using Docker)
- Run migrations: `npm run prisma:migrate`
- Regenerate Prisma client: `npm run prisma:generate`

## Next Steps

Once WorkOS is set up and tested:
1. ✅ Backend authentication is ready
2. ✅ Mobile app can integrate with WorkOS
3. ✅ Protected routes can use authentication middleware
