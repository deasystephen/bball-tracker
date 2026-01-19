# Invitation System Migration Steps

## Prerequisites

Before running the migration, ensure:
1. Database is running and accessible
2. You have a backup of your database (recommended)
3. All existing team members will be grandfathered in (no data loss)

## Migration Steps

### 1. Create and Apply Migration

```bash
cd backend
npx prisma migrate dev --name add_team_invitations
```

This will:
- Create a new migration file
- Apply the migration to your database
- Regenerate the Prisma client with the new `TeamInvitation` model

### 2. Verify Migration

Check that the migration was successful:

```bash
npx prisma studio
```

You should see the new `TeamInvitation` table in the database.

### 3. Generate Prisma Client

If the migration didn't automatically generate the client:

```bash
npx prisma generate
```

### 4. Test the API

After migration, test the invitation endpoints:

```bash
# Create an invitation
curl -X POST http://localhost:3000/api/v1/teams/TEAM_ID/invitations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "playerId": "PLAYER_ID",
    "jerseyNumber": 23,
    "position": "Forward"
  }'
```

## Breaking Changes

### Removed Endpoint

- `POST /api/v1/teams/:id/players` - **REMOVED**
  - This endpoint now returns HTTP 410 (Gone) with a message directing to use invitations
  - All new player additions must go through the invitation system

### New Endpoints

- `POST /api/v1/teams/:teamId/invitations` - Create invitation
- `GET /api/v1/invitations` - List invitations
- `GET /api/v1/invitations/:id` - Get invitation
- `POST /api/v1/invitations/:id/accept` - Accept invitation
- `POST /api/v1/invitations/:id/reject` - Reject invitation
- `DELETE /api/v1/invitations/:id` - Cancel invitation

## Data Migration

### Existing Team Members

All existing `TeamMember` records remain unchanged. They are "grandfathered" in and don't require invitations.

### Future Additions

All new team members must:
1. Receive an invitation from the coach
2. Accept the invitation
3. Then be added to the team

## Rollback

If you need to rollback:

```bash
cd backend
npx prisma migrate resolve --rolled-back add_team_invitations
npx prisma migrate reset  # WARNING: This will delete all data
```

Or manually:
1. Drop the `TeamInvitation` table
2. Remove the enum `InvitationStatus`
3. Remove relations from `User` and `Team` models
4. Regenerate Prisma client

## Testing Checklist

After migration:
- [ ] Verify `TeamInvitation` table exists
- [ ] Test creating an invitation
- [ ] Test accepting an invitation
- [ ] Test rejecting an invitation
- [ ] Test cancelling an invitation
- [ ] Verify existing team members still work
- [ ] Test that direct add player endpoint returns 410
