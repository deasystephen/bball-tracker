# Players API Testing Guide

Manual smoke test of `/api/v1/players` against a local development backend. The automated
equivalent is `backend/scripts/test-players-api.sh`; the executable truth for every status below
is `backend/tests/api/players.test.ts` and `backend/tests/services/player-service.test.ts`.
Every cURL in this guide was run against a seeded local backend at `main@7658e8b` and returned
the status shown. Never point any of this at production.

## Prerequisites

1. **Backend running in development mode**: `cd backend && npm run dev` with `NODE_ENV=development`
   in `backend/.env` (`cp env.example .env` sets it). `POST /auth/dev-login` exists only in that mode.
2. **Database migrated and seeded**: `npm run prisma:migrate && npx prisma db seed`. The seed creates
   the system admin `admin@bball-tracker.com` plus coaches, players and two teams.
3. **`jq`** (`brew install jq`) for the script and for reading responses.

## Getting an Access Token

The token must belong to a system **ADMIN** for everything in this guide to pass:

- `POST /players` (pre-create an account for an email) is ADMIN or roster-managing staff only (403 otherwise).
- `GET /players` is scoped to the caller's teams for everyone but ADMIN, and `search` matches `email`
  only for ADMIN (non-admins: name only, and `email` is omitted from list results).
- `GET /players/:id` returns 404 to a non-admin who shares no team with the player, and `email: null`
  to a non-admin who does.
- `DELETE /players/:id` of an un-rostered player older than the 24-hour grace window is ADMIN-only.

### Option 1: let the script dev-login for you

With no token argument, the script calls `POST /auth/dev-login` as the seeded admin and checks the
role before running:

```bash
cd backend
./scripts/test-players-api.sh http://localhost:3000
```

### Option 2: dev-login by hand

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/dev-login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@bball-tracker.com"}' | jq -r .accessToken)
```

The response is `{ "success": true, "user": { id, email, name, role, leagueAdminOf, guardianOf },
"accessToken": "dev_…" }` (HTTP 200). The token is valid for 24 hours and is accepted by every route
through the normal `authenticate` middleware. An email the seed did not create answers
`404 { "error": "User not found", "hint": "…" }`. `GET /api/v1/auth/me` with the token echoes the
user, so `curl -s http://localhost:3000/api/v1/auth/me -H "Authorization: Bearer $TOKEN" | jq .user.role`
is the quickest way to confirm `ADMIN`.

A real WorkOS token works too (`GET /auth/callback` returns it in the JSON body together with the
refresh token), but dev-login is the path the seed, the script and the Maestro flows use.

## Running the Test Script

```bash
cd backend
./scripts/test-players-api.sh http://localhost:3000                       # dev-login as the seeded admin
./scripts/test-players-api.sh http://localhost:3000 "$TOKEN"              # or an explicit ADMIN token
```

The script creates two players with unique emails, exercises get/list/search/update/pagination, checks
the duplicate-email 400 and the unknown-id 404, then deletes what it created and prints a summary.

## Manual Testing with cURL

Export `TOKEN` as above; the examples use `http://localhost:3000`.

### 1. Create a Player

`POST /players` pre-creates an account (role `PLAYER`) for an email address, which `syncUser` claims
when that person first signs in. It is **not** a prerequisite for putting someone on a roster: the
unified Add Player endpoint (section "Integration with Teams API") creates the player row itself.

```bash
curl -X POST http://localhost:3000/api/v1/players \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "name": "John Doe",
    "email": "john.doe@example.com"
  }'
```

**Expected: HTTP 201**
```json
{
  "success": true,
  "player": {
    "id": "uuid-here",
    "email": "john.doe@example.com",
    "name": "John Doe",
    "role": "PLAYER",
    "profilePictureUrl": null,
    "emailVerified": false,
    "createdAt": "2026-10-04T00:23:27.136Z",
    "updatedAt": "2026-10-04T00:23:27.136Z"
  }
}
```

A caller who is neither ADMIN nor staff with `canManageRoster` on some team (nor a league admin)
gets `403 { "error": "Only administrators and team staff who manage a roster can create players" }`.

### 2. List Players

```bash
curl -X GET "http://localhost:3000/api/v1/players" \
  -H "Authorization: Bearer $TOKEN"
```

**Expected: HTTP 200**
```json
{
  "success": true,
  "players": [
    {
      "id": "uuid-here",
      "email": "andrew.wiggins@example.com",
      "name": "Andrew Wiggins",
      "role": "PLAYER",
      "profilePictureUrl": null,
      "emailVerified": true,
      "createdAt": "…",
      "updatedAt": "…",
      "_count": { "teamMembers": 1 }
    }
  ],
  "pagination": { "total": 12, "limit": 20, "offset": 0, "hasMore": false }
}
```

**With search** (ADMIN: name or email; everyone else: name only):
```bash
curl -X GET "http://localhost:3000/api/v1/players?search=john" \
  -H "Authorization: Bearer $TOKEN"
```

**With pagination** (`limit` 1–100, default 20; `offset` default 0):
```bash
curl -X GET "http://localhost:3000/api/v1/players?limit=10&offset=0" \
  -H "Authorization: Bearer $TOKEN"
```

`role` and `isManaged` are additional ADMIN-only filters; other callers' values are ignored.

### 3. Get Player by ID

```bash
curl -X GET "http://localhost:3000/api/v1/players/PLAYER_ID" \
  -H "Authorization: Bearer $TOKEN"
```

**Expected: HTTP 200** (the detail payload is `PLAYER_DETAIL_SELECT` in `player-service.ts`):
```json
{
  "success": true,
  "player": {
    "id": "uuid-here",
    "email": "andrew.wiggins@example.com",
    "name": "Andrew Wiggins",
    "role": "PLAYER",
    "profilePictureUrl": null,
    "emailVerified": true,
    "createdAt": "…",
    "updatedAt": "…",
    "isManaged": false,
    "managedById": null,
    "deletedAt": null,
    "teamMembers": [
      {
        "id": "team-member-id",
        "teamId": "team-id",
        "playerId": "uuid-here",
        "jerseyNumber": 22,
        "position": "SF",
        "createdAt": "…",
        "updatedAt": "…",
        "team": {
          "id": "team-id",
          "name": "Warriors",
          "season": {
            "id": "season-id",
            "name": "Spring 2024",
            "league": { "id": "league-id", "name": "Downtown Youth Basketball League" }
          }
        }
      }
    ]
  }
}
```

A player on no team has `"teamMembers": []`. For a non-admin caller who shares a team with the
player, `email` is `null`.

### 4. Update Player

```bash
curl -X PATCH http://localhost:3000/api/v1/players/PLAYER_ID \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "name": "John Doe Updated"
  }'
```

**Expected: HTTP 200** with the updated player (same shape as section 1). `name`, `email` and
`profilePictureUrl` are the editable fields.

### 5. Delete Player

```bash
curl -X DELETE http://localhost:3000/api/v1/players/PLAYER_ID \
  -H "Authorization: Bearer $TOKEN"
```

**Expected: HTTP 200** `{ "success": true, "message": "Player deleted successfully" }`.

A player can only be deleted if they are on no team and have no game events; otherwise the API
answers 400 (see "Cannot delete player" below). A non-admin may delete only a managed player they
created, while that player is on no team and is less than 24 hours old (403 otherwise).

## Testing Scenarios

### Scenario 1: Create and List Players

1. Create 3-5 test players with different names/emails
2. List all players - verify all appear (ADMIN sees every player; a coach sees only their teams')
3. Search for a specific player by name
4. Search for a specific player by email (ADMIN only)

### Scenario 2: Player on Multiple Teams

1. Add a player to Team A with the unified Add Player endpoint (section "Integration with Teams API")
2. Add the same person to Team B (same `playerEmail`)
3. Get player details - verify both teams appear in `teamMembers`

### Scenario 3: Update Player

1. Create a player
2. Update player name
3. Get player - verify name changed
4. Try to update email to an existing email (should fail with 400)

### Scenario 4: Delete Restrictions

1. Add a player to a team
2. Try to delete the player - fails with 400 (on a team)
3. Remove the player from the team (`DELETE /teams/:teamId/players/:playerId`)
4. Delete the player - succeeds

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
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name": "Player One", "email": "test@example.com"}'

# Try to create second player with same email
curl -X POST http://localhost:3000/api/v1/players \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name": "Player Two", "email": "test@example.com"}'
```

**Expected:** HTTP 400 `{ "error": "A user with this email already exists" }` (409 only if the
unique index wins a race the pre-check missed).

### 2. Invalid Email Format

```bash
curl -X POST http://localhost:3000/api/v1/players \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name": "Test", "email": "invalid-email"}'
```

**Expected:** HTTP 400 `{ "error": "Invalid email format" }`

### 3. Missing Required Fields

```bash
curl -X POST http://localhost:3000/api/v1/players \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"email": "test@example.com"}'
```

**Expected:** HTTP 400 `{ "error": "Invalid input: expected string, received undefined" }` (Zod's
message for an absent `name`; an empty string answers `"Name is required"`).

### 4. Player Not Found

A malformed id never reaches the service: `validateUuidParams('id')` rejects it first.

```bash
curl -X GET "http://localhost:3000/api/v1/players/invalid-uuid" \
  -H "Authorization: Bearer $TOKEN"
```

**Expected:** HTTP 400 `{ "error": "Invalid id format" }`

Use a well-formed UUID that matches no row to see the 404:

```bash
curl -X GET "http://localhost:3000/api/v1/players/00000000-0000-4000-8000-000000000000" \
  -H "Authorization: Bearer $TOKEN"
```

**Expected:** HTTP 404 `{ "error": "Player not found" }`

### 5. Unauthorized Access

```bash
curl -X GET "http://localhost:3000/api/v1/players"
# No Authorization header
```

**Expected:** HTTP 401 `{ "error": "Authorization token required" }`

### 6. Delete a rostered player

```bash
curl -X DELETE http://localhost:3000/api/v1/players/ROSTERED_PLAYER_ID \
  -H "Authorization: Bearer $TOKEN"
```

**Expected:** HTTP 400 `{ "error": "Cannot delete player who is currently on teams. Remove player from all teams first." }`

## Integration with Teams API

### Add Player to Team

`POST /teams/:teamId/players` is the unified Add Player endpoint (`addRosterPlayerSchema`). `name` is
the only required field; `playerEmail` decides whether an invitation email goes out; `guardianEmail`
(with `guardianRelationship`) additionally invites a parent. It creates the player row itself, so no
prior `POST /players` is needed, and there is no `playerId` field.

```bash
curl -X POST http://localhost:3000/api/v1/teams/TEAM_ID/players \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "name": "John Doe",
    "playerEmail": "john.doe@example.com",
    "jerseyNumber": 23,
    "position": "Forward"
  }'
```

**Expected: HTTP 201**
```json
{
  "success": true,
  "rostered": true,
  "invited": false,
  "member": {
    "id": "team-member-id",
    "teamId": "TEAM_ID",
    "playerId": "player-id",
    "jerseyNumber": 23,
    "position": "Forward",
    "createdAt": "…",
    "updatedAt": "…",
    "player": { "id": "player-id", "name": "John Doe", "email": null, "isManaged": true, "managedById": "caller-id" },
    "team": { "id": "TEAM_ID", "name": "Lakers" }
  },
  "invitation": null,
  "guardianInvited": false,
  "emails": {}
}
```

(The body above is the no-email case; with `playerEmail` the response also carries `invited: true`,
an `invitation` summary without its token, and `emails.player` for that send.)

The old `{ "playerId": "…", "jerseyNumber": 23, "position": "Forward" }` body fails validation:
**HTTP 400** `{ "error": "Invalid input: expected string, received undefined" }` (no `name`).

Then `GET /players/PLAYER_ID` shows the team in `teamMembers`. Remove the roster entry with
`DELETE /teams/TEAM_ID/players/PLAYER_ID` (HTTP 200).

## Troubleshooting

### Issue: "Authorization token required"

**Solution:** Make sure you're including the `Authorization: Bearer TOKEN` header in all requests.

### Issue: dev-login answers 404 "User not found"

**Solution:** The database is not seeded, or the email is not one the seed creates. Run
`npx prisma db seed` in `backend/` and use `admin@bball-tracker.com`. If the route itself is a 404,
the backend is not running with `NODE_ENV=development`.

### Issue: "Player not found" when player exists

`GET /players/:id` answers 404 in three cases, on purpose, so ids cannot be probed:

1. The user's role is not `PLAYER` (coaches, parents and admins are not players).
2. The account is deleted (a tombstone row with `deletedAt` set).
3. The caller is not ADMIN and shares no team with the player (caller scoping). This is the one a
   tester with a coach token hits most often: use an ADMIN token, or pick a player on one of the
   caller's teams.

A malformed id is a different error, 400 `Invalid id format`.

### Issue: Cannot delete player

**Solution:** Players can only be deleted if:
- They are not members of any teams (400 "Cannot delete player who is currently on teams…")
- They have no game events (400 "Cannot delete player with game history…")

Remove the player from all teams first, then try deleting again. A non-admin also needs to be the
player's current manager (403 "Only administrators can delete players" otherwise).

## Next Steps

After testing the Players API:
1. Test the unified Add Player flow end to end (`docs/architecture/roster-and-invitations.md`)
2. Test the mobile app's player search and Add Player sheet
3. Verify a player can be on multiple teams
4. Walk the relevant sections of `docs/testing/e2e-test-plan-v2.0.md`
