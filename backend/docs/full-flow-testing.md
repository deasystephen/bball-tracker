# Full Flow Testing Guide

This guide walks through testing the complete flow: **League → Team → Players → Game**

## Prerequisites

1. **Backend server running**: `npm run dev` in `backend/` directory
2. **Database migrated**: `npm run prisma:migrate` (already done)
3. **WorkOS authentication**: A valid access token from WorkOS
4. **At least one user in database**: Created via WorkOS authentication

## Step 1: Get an Access Token

First, authenticate with WorkOS to get an access token:

### Method 1: Browser Authentication (Recommended)

1. **Open your browser** and visit:
   ```
   http://localhost:3000/api/v1/auth/login
   ```
   This will redirect you to WorkOS for authentication.

2. **Sign in with WorkOS** (email/password)

3. **After authentication**, WorkOS will redirect you back to:
   ```
   http://localhost:3000/api/v1/auth/callback?code=...
   ```

4. **The callback endpoint** will automatically exchange the code for a token and return a JSON response like:
   ```json
   {
     "success": true,
     "accessToken": "your_access_token_here",
     "user": { ... }
   }
   ```

5. **Copy the `accessToken`** from the response.

### Method 2: Get URL First (Alternative)

If you want to see the URL first:

```bash
# Get the authorization URL
curl http://localhost:3000/api/v1/auth/login?format=json
```

This returns:
```json
{"url": "https://api.workos.com/user_management/authorize?..."}
```

Then manually visit that URL in your browser and follow the same steps as Method 1.

### Save Your Token

Set it as an environment variable for the test script:

```bash
export TOKEN="your_access_token_here"
```

## Step 2: Create a League

```bash
curl -X POST http://localhost:3000/api/v1/leagues \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Youth Basketball League",
    "season": "Winter 2024",
    "year": 2024
  }'
```

**Save the league ID** from the response (e.g., `league_123...`)

## Step 3: Create a Team

```bash
# Replace LEAGUE_ID with the ID from Step 2
curl -X POST http://localhost:3000/api/v1/teams \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Thunder",
    "leagueId": "LEAGUE_ID"
  }'
```

**Note**: The authenticated user will automatically be set as the coach.

**Save the team ID** from the response (e.g., `team_123...`)

## Step 4: Get Your User ID

You'll need your user ID to add yourself as a player (or create another user):

```bash
curl -X GET http://localhost:3000/api/v1/auth/me \
  -H "Authorization: Bearer $TOKEN"
```

**Save your user ID** from the response (e.g., `user_123...`)

## Step 5: Add Players to Team

```bash
# Replace TEAM_ID with the ID from Step 3
# Replace PLAYER_ID with a user ID (can be your own or another user)
curl -X POST http://localhost:3000/api/v1/teams/TEAM_ID/players \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "playerId": "PLAYER_ID",
    "jerseyNumber": 23,
    "position": "Forward"
  }'
```

Repeat this step to add more players.

## Step 6: Create a Game

```bash
# Replace TEAM_ID with the ID from Step 3
curl -X POST http://localhost:3000/api/v1/games \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "teamId": "TEAM_ID",
    "opponent": "Lakers",
    "date": "2024-01-15T18:00:00Z",
    "status": "SCHEDULED",
    "homeScore": 0,
    "awayScore": 0
  }'
```

**Save the game ID** from the response (e.g., `game_123...`)

## Step 7: Verify Everything

### Get the team with all details:

```bash
curl -X GET http://localhost:3000/api/v1/teams/TEAM_ID \
  -H "Authorization: Bearer $TOKEN"
```

### Get the game with all details:

```bash
curl -X GET http://localhost:3000/api/v1/games/GAME_ID \
  -H "Authorization: Bearer $TOKEN"
```

### List all teams:

```bash
curl -X GET http://localhost:3000/api/v1/teams \
  -H "Authorization: Bearer $TOKEN"
```

### List all games:

```bash
curl -X GET http://localhost:3000/api/v1/games \
  -H "Authorization: Bearer $TOKEN"
```

## Complete Test Script

Here's a complete bash script that automates the flow (requires `jq` for JSON parsing):

```bash
#!/bin/bash

# Set your token
TOKEN="your_token_here"

# Step 1: Create League
echo "Creating league..."
LEAGUE_RESPONSE=$(curl -s -X POST http://localhost:3000/api/v1/leagues \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test League",
    "season": "Winter 2024",
    "year": 2024
  }')

LEAGUE_ID=$(echo $LEAGUE_RESPONSE | jq -r '.league.id')
echo "League created: $LEAGUE_ID"

# Step 2: Get User ID
echo "Getting user info..."
USER_RESPONSE=$(curl -s -X GET http://localhost:3000/api/v1/auth/me \
  -H "Authorization: Bearer $TOKEN")

USER_ID=$(echo $USER_RESPONSE | jq -r '.user.id')
echo "User ID: $USER_ID"

# Step 3: Create Team
echo "Creating team..."
TEAM_RESPONSE=$(curl -s -X POST http://localhost:3000/api/v1/teams \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"Thunder\",
    \"leagueId\": \"$LEAGUE_ID\"
  }")

TEAM_ID=$(echo $TEAM_RESPONSE | jq -r '.team.id')
echo "Team created: $TEAM_ID"

# Step 4: Add Player
echo "Adding player to team..."
curl -s -X POST http://localhost:3000/api/v1/teams/$TEAM_ID/players \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"playerId\": \"$USER_ID\",
    \"jerseyNumber\": 23,
    \"position\": \"Forward\"
  }"
echo "Player added"

# Step 5: Create Game
echo "Creating game..."
GAME_RESPONSE=$(curl -s -X POST http://localhost:3000/api/v1/games \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"teamId\": \"$TEAM_ID\",
    \"opponent\": \"Lakers\",
    \"date\": \"2024-01-15T18:00:00Z\",
    \"status\": \"SCHEDULED\"
  }")

GAME_ID=$(echo $GAME_RESPONSE | jq -r '.game.id')
echo "Game created: $GAME_ID"

echo ""
echo "✅ Full flow test complete!"
echo "League ID: $LEAGUE_ID"
echo "Team ID: $TEAM_ID"
echo "Game ID: $GAME_ID"
```

## Troubleshooting

### 401 Unauthorized
- Check that your token is valid and not expired
- Re-authenticate if needed

### 404 Not Found
- Verify IDs are correct (UUID format)
- Check that resources exist in the database

### 403 Forbidden
- Ensure you're the coach of the team (for team/game operations)
- Check user roles and permissions

### 400 Bad Request
- Verify request body matches the schema
- Check that required fields are present
- Ensure data types are correct (UUIDs, dates, etc.)

## Next Steps

After testing the full flow:
1. Test Game Events API (when implemented)
2. Test real-time updates via WebSocket
3. Test with the mobile app
4. Add more complex scenarios (multiple teams, multiple games, etc.)
