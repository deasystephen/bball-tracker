# Games API Testing Guide

## Prerequisites

Before testing the Games API, you need:

1. **Backend server running**: `npm run dev` in `backend/` directory
2. **Database migrated**: `npm run prisma:migrate` (already done)
3. **WorkOS authentication**: A valid access token from WorkOS
4. **Test data**: At least one team in the database

## Testing with cURL

### 1. Get an Access Token

First, authenticate with WorkOS to get an access token:

```bash
# Start the login flow (this will open a browser)
curl http://localhost:3000/api/v1/auth/login?format=json

# After authenticating, you'll get redirected with a code
# Exchange the code for a token:
curl -X GET "http://localhost:3000/api/v1/auth/callback?code=YOUR_CODE_HERE"
```

The response will include an `accessToken`. Save this token for subsequent requests.

### 2. Test Authentication Required

All Games API endpoints require authentication. Test that unauthenticated requests fail:

```bash
# Should return 401 Unauthorized
curl -X GET http://localhost:3000/api/v1/games
```

### 3. Create a Game

**Note**: You need a `teamId` to create a game. The team must exist and you must be the coach.

```bash
# Replace YOUR_TOKEN with your WorkOS access token
# Replace TEAM_ID with a valid team ID from your database
curl -X POST http://localhost:3000/api/v1/games \
  -H "Authorization: Bearer YOUR_TOKEN" \
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

**Expected Response** (201 Created):
```json
{
  "success": true,
  "game": {
    "id": "game-uuid",
    "teamId": "TEAM_ID",
    "opponent": "Lakers",
    "date": "2024-01-15T18:00:00.000Z",
    "status": "SCHEDULED",
    "homeScore": 0,
    "awayScore": 0,
    "team": {
      "id": "TEAM_ID",
      "name": "Team Name",
      "league": { ... },
      "coach": { ... }
    }
  }
}
```

### 4. List Games

```bash
curl -X GET "http://localhost:3000/api/v1/games" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**With Filters**:
```bash
# Filter by team
curl -X GET "http://localhost:3000/api/v1/games?teamId=TEAM_ID" \
  -H "Authorization: Bearer YOUR_TOKEN"

# Filter by status
curl -X GET "http://localhost:3000/api/v1/games?status=IN_PROGRESS" \
  -H "Authorization: Bearer YOUR_TOKEN"

# Filter by date range
curl -X GET "http://localhost:3000/api/v1/games?startDate=2024-01-01T00:00:00Z&endDate=2024-01-31T23:59:59Z" \
  -H "Authorization: Bearer YOUR_TOKEN"

# Pagination
curl -X GET "http://localhost:3000/api/v1/games?limit=10&offset=0" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Expected Response**:
```json
{
  "success": true,
  "games": [...],
  "total": 5,
  "limit": 20,
  "offset": 0
}
```

### 5. Get Game by ID

```bash
curl -X GET "http://localhost:3000/api/v1/games/GAME_ID" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Expected Response**:
```json
{
  "success": true,
  "game": {
    "id": "GAME_ID",
    "teamId": "TEAM_ID",
    "opponent": "Lakers",
    "date": "2024-01-15T18:00:00.000Z",
    "status": "SCHEDULED",
    "homeScore": 0,
    "awayScore": 0,
    "team": { ... },
    "events": []
  }
}
```

### 6. Update a Game

**Note**: Only the team coach can update games.

```bash
curl -X PATCH "http://localhost:3000/api/v1/games/GAME_ID" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "IN_PROGRESS",
    "homeScore": 10,
    "awayScore": 8
  }'
```

### 7. Delete a Game

**Note**: Only the team coach can delete games.

```bash
curl -X DELETE "http://localhost:3000/api/v1/games/GAME_ID" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Expected Response**:
```json
{
  "success": true,
  "message": "Game deleted successfully"
}
```

## Testing with Postman

1. Import the collection (if available)
2. Set the `Authorization` header to `Bearer YOUR_TOKEN`
3. Update variables:
   - `base_url`: `http://localhost:3000/api/v1`
   - `token`: Your WorkOS access token
   - `team_id`: A valid team ID
   - `game_id`: A valid game ID (after creating one)

## Common Issues

### 401 Unauthorized
- **Cause**: Missing or invalid access token
- **Solution**: Re-authenticate with WorkOS and get a new token

### 403 Forbidden
- **Cause**: User is not the team coach (for create/update/delete)
- **Solution**: Ensure you're authenticated as the team coach

### 404 Not Found
- **Cause**: Game or team doesn't exist
- **Solution**: Verify the ID is correct and the resource exists

### 400 Bad Request
- **Cause**: Invalid request data (missing required fields, wrong format)
- **Solution**: Check the request body matches the schema requirements

## Setting Up Test Data

If you need to create test data (teams, leagues), you can:

1. Use Prisma Studio: `npm run prisma:studio`
2. Create a seed script
3. Use the API (if Teams API is implemented)

## Next Steps

After testing the Games API:
1. Test with the mobile app
2. Add game events (shots, rebounds, etc.)
3. Test real-time updates via WebSocket
