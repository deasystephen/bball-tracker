# WorkOS Setup Guide

## Prerequisites

1. Create a WorkOS account at https://workos.com
2. Create a new project in WorkOS dashboard
3. Get your API key and Client ID

## Configuration

### 1. Get WorkOS Credentials

1. Log in to WorkOS dashboard
2. Navigate to your project
3. Go to **API Keys** section
4. Copy your **API Key** (starts with `sk_`)
5. Go to **Configuration** → **Client IDs**
6. Copy your **Client ID** (starts with `client_`)

### 2. Set Environment Variables

Add to your `.env` file:

```env
WORKOS_API_KEY="sk_test_..." # or sk_live_... for production
WORKOS_CLIENT_ID="client_..."
WORKOS_ENVIRONMENT="sandbox" # or "production"
WORKOS_REDIRECT_URI="http://localhost:3000/api/v1/auth/callback"
```

### 3. Configure Redirect URI in WorkOS

1. Go to WorkOS dashboard → **Configuration** → **Redirect URIs**
2. Add: `http://localhost:3000/api/v1/auth/callback`
3. For production, add your production callback URL

### 4. Run Database Migration

Update the database schema to remove password field and add WorkOS fields:

```bash
cd backend
npm run prisma:migrate
```

This will:
- Remove `password` field from User model
- Add `workosUserId` field
- Add `emailVerified` field
- Remove `RefreshToken` model (WorkOS handles tokens)

## Testing the Integration

### 1. Start the Backend

```bash
npm run dev
```

### 2. Test Login Flow

1. Open browser: `http://localhost:3000/api/v1/auth/login`
2. You'll be redirected to WorkOS login page
3. Sign in (or create account)
4. You'll be redirected back to callback URL
5. Check response for user info and access token

### 3. Test Protected Endpoint

```bash
# Get access token from login response
curl -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  http://localhost:3000/api/v1/auth/me
```

## API Endpoints

### `GET /api/v1/auth/login`
Redirects to WorkOS authorization page

### `GET /api/v1/auth/callback?code=...`
Handles OAuth callback, returns:
```json
{
  "success": true,
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "name": "User Name",
    "role": "PLAYER"
  },
  "accessToken": "workos_access_token"
}
```

### `GET /api/v1/auth/me`
Get current user (requires Authorization header)
```bash
Authorization: Bearer YOUR_ACCESS_TOKEN
```

## Using Authentication Middleware

Protect routes with authentication:

```typescript
import { authenticate, requireRole } from '../api/auth';

// Require authentication
router.get('/protected', authenticate, (req, res) => {
  // req.user is available
  res.json({ user: req.user });
});

// Require specific role
router.get('/admin-only', 
  authenticate, 
  requireRole('ADMIN'),
  (req, res) => {
    res.json({ message: 'Admin access granted' });
  }
);
```

## Mobile App Integration

The mobile app will:
1. Open WorkOS login URL in browser/webview
2. User authenticates with WorkOS
3. Receive callback with access token
4. Store token securely (Keychain/SecureStore)
5. Include token in API requests: `Authorization: Bearer TOKEN`

## Next Steps

1. Set up WorkOS account and get credentials
2. Update `.env` with WorkOS keys
3. Run database migration
4. Test login flow
5. Integrate with mobile app

## Resources

- [WorkOS Documentation](https://workos.com/docs)
- [WorkOS Node.js SDK](https://github.com/workos/workos-node)
- [WorkOS React Native SDK](https://github.com/workos/workos-react-native)

