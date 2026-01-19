# Players API Testing Guide

This guide explains how to test the Players API endpoints.

## Prerequisites

1. **Backend server running**: The backend should be running on `http://localhost:3000` (or your configured port)
2. **Authentication token**: You need a valid WorkOS access token
3. **Database**: PostgreSQL database should be set up and migrations applied

## Getting an Access Token

### Option 1: Use the Login Flow

1. Start the backend: `npm run dev`
2. Open your browser and navigate to: `http://localhost:3000/api/v1/auth/login`
3. Complete the WorkOS authentication flow
4. After redirect, check the callback URL - the access token will be in the query parameters or you can extract it from the browser's network tab

### Option 2: Use the Mobile App

1. Use the mobile app to log in
2. The access token is stored in the app's auth store
3. You can extract it from the app's AsyncStorage or network requests

### Option 3: Manual Token Extraction

If you've logged in via the web, you can extract the token from:
- Browser cookies/localStorage
- Network request headers in browser DevTools
- Backend logs (if enabled)

## Running the Test Script

The automated test script tests all Players API endpoints:

```bash
cd backend
./scripts/test-players-api.sh http://localhost:3000 "your-access-token-here"
```

### Example

```bash
./scripts/test-players-api.sh http://localhost:3000 "eyJhbGciOiJSUzI1NiIsImtpZCI6..."
```

## Manual Testing with cURL

### 1. Create a Player

```bash
curl -X POST http://localhost:3000/api/v1/players \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -d '{
    "name": "John Doe",
    "email": "john.doe@example.com"
  }'
```

**Expected Response:**
```json
{
  "success": true,
  "player": {
    "id": "uuid-here",
    "email": "john.doe@example.com",
    "name": "John Doe",
    "role": "PLAYER",
    "emailVerified": false,
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z"
  }
}
```

### 2. List Players

```bash
curl -X GET "http://localhost:3000/api/v1/players" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

**With Search:**
```bash
curl -X GET "http://localhost:3000/api/v1/players?search=john" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

**With Pagination:**
```bash
curl -X GET "http://localhost:3000/api/v1/players?limit=10&offset=0" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

### 3. Get Player by ID

```bash
curl -X GET "http://localhost:3000/api/v1/players/PLAYER_ID" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

**Expected Response:**
```json
{
  "success": true,
  "player": {
    "id": "uuid-here",
    "email": "john.doe@example.com",
    "name": "John Doe",
    "role": "PLAYER",
    "teamMembers": [
      {
        "id": "team-member-id",
        "team": {
          "id": "team-id",
          "name": "Team Name",
          "league": {
            "id": "league-id",
            "name": "League Name",
            "season": "Winter",
            "year": 2024
          }
        }
      }
    ]
  }
}
```

### 4. Update Player

```bash
curl -X PATCH http://localhost:3000/api/v1/players/PLAYER_ID \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -d '{
    "name": "John Doe Updated"
  }'
```

### 5. Delete Player

```bash
curl -X DELETE http://localhost:3000/api/v1/players/PLAYER_ID \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

**Note:** Players can only be deleted if:
- They are not on any teams
- They have no game events

## Testing Scenarios

### Scenario 1: Create and List Players

1. Create 3-5 test players with different names/emails
2. List all players - verify all appear
3. Search for a specific player by name
4. Search for a specific player by email

### Scenario 2: Player on Multiple Teams

1. Create a player
2. Add player to Team A
3. Add player to Team B
4. Get player details - verify both teams appear in `teamMembers`

### Scenario 3: Update Player

1. Create a player
2. Update player name
3. Get player - verify name changed
4. Try to update email to an existing email (should fail)

### Scenario 4: Delete Restrictions

1. Create a player
2. Add player to a team
3. Try to delete player - should fail with error about being on teams
4. Remove player from team
5. Delete player - should succeed

### Scenario 5: Search Functionality

1. Create players with names: "Alice", "Bob", "Charlie"
2. Search for "alice" (case-insensitive) - should find Alice
3. Search for "b" - should find Bob
4. Search for "xyz" - should return empty results

## Error Cases to Test

### 1. Duplicate Email

```bash
# Create first player
curl -X POST http://localhost:3000/api/v1/players \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -d '{"name": "Player One", "email": "test@example.com"}'

# Try to create second player with same email
curl -X POST http://localhost:3000/api/v1/players \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -d '{"name": "Player Two", "email": "test@example.com"}'
```

**Expected:** HTTP 400 with error message about duplicate email

### 2. Invalid Email Format

```bash
curl -X POST http://localhost:3000/api/v1/players \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -d '{"name": "Test", "email": "invalid-email"}'
```

**Expected:** HTTP 400 with validation error

### 3. Missing Required Fields

```bash
curl -X POST http://localhost:3000/api/v1/players \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -d '{"email": "test@example.com"}'
```

**Expected:** HTTP 400 with validation error about missing name

### 4. Player Not Found

```bash
curl -X GET "http://localhost:3000/api/v1/players/invalid-uuid" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

**Expected:** HTTP 404 with "Player not found" error

### 5. Unauthorized Access

```bash
curl -X GET "http://localhost:3000/api/v1/players" \
  # No Authorization header
```

**Expected:** HTTP 401 with "Authorization token required" error

## Integration with Teams API

### Add Player to Team

1. Create a player using Players API
2. Create a team (or use existing)
3. Add player to team using Teams API:

```bash
curl -X POST http://localhost:3000/api/v1/teams/TEAM_ID/players \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -d '{
    "playerId": "PLAYER_ID",
    "jerseyNumber": 23,
    "position": "Forward"
  }'
```

4. Get player details - verify team appears in `teamMembers`

## Troubleshooting

### Issue: "Authorization token required"

**Solution:** Make sure you're including the `Authorization: Bearer TOKEN` header in all requests.

### Issue: "User not found"

**Solution:** The token is valid but the user doesn't exist in the database. Make sure you've completed the WorkOS authentication flow and the user was created in the database.

### Issue: "Player not found" when player exists

**Solution:** Check that:
1. The player ID is correct
2. The player's role is actually "PLAYER" (not "COACH" or other role)

### Issue: Cannot delete player

**Solution:** Players can only be deleted if:
- They are not members of any teams
- They have no game events

Remove the player from all teams first, then try deleting again.

## Next Steps

After testing the Players API:
1. Test the integration with Teams API (adding players to teams)
2. Test the mobile app's player search and creation flow
3. Verify players can be on multiple teams
4. Test edge cases and error handling
