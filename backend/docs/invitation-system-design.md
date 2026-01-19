# Team Invitation System Design

## Overview

Implement an invitation-based system where players can only join teams when invited by a coach and accept the invitation.

## Current Flow

**Current:** Coach directly adds player → Player is immediately on team

**New Flow:** Coach sends invitation → Player receives invitation → Player accepts → Player is added to team

## Database Schema Changes

### New Model: TeamInvitation

```prisma
enum InvitationStatus {
  PENDING
  ACCEPTED
  REJECTED
  EXPIRED
  CANCELLED
}

model TeamInvitation {
  id          String           @id @default(uuid())
  teamId      String
  playerId    String
  invitedById String           // Coach who sent the invitation
  status      InvitationStatus @default(PENDING)
  token       String           @unique // Secure token for accepting
  jerseyNumber Int?
  position    String?
  message     String?          // Optional message from coach
  expiresAt   DateTime         // Invitation expiration (e.g., 7 days)
  createdAt   DateTime         @default(now())
  updatedAt   DateTime         @updatedAt
  acceptedAt  DateTime?
  rejectedAt  DateTime?

  team        Team  @relation(fields: [teamId], references: [id], onDelete: Cascade)
  player      User  @relation("PlayerInvitations", fields: [playerId], references: [id], onDelete: Cascade)
  invitedBy   User  @relation("SentInvitations", fields: [invitedById], references: [id])

  @@unique([teamId, playerId, status]) // One pending invitation per team-player pair
  @@index([playerId])
  @@index([teamId])
  @@index([status])
  @@index([token])
  @@index([expiresAt])
}
```

### Update User Model

Add relations to User model:

```prisma
model User {
  // ... existing fields ...
  
  // Relations
  sentInvitations    TeamInvitation[] @relation("SentInvitations")
  receivedInvitations TeamInvitation[] @relation("PlayerInvitations")
  // ... existing relations ...
}
```

### Update Team Model

Add relation to Team model:

```prisma
model Team {
  // ... existing fields ...
  
  invitations TeamInvitation[]
  // ... existing relations ...
}
```

## Backend API Changes

### New Endpoints

#### 1. Create Invitation (Coach)
```
POST /api/v1/teams/:teamId/invitations
Body: {
  playerId: string,
  jerseyNumber?: number,
  position?: string,
  message?: string,
  expiresInDays?: number (default: 7)
}
```

#### 2. List Invitations (Coach)
```
GET /api/v1/teams/:teamId/invitations
Query: ?status=PENDING|ACCEPTED|REJECTED|EXPIRED
```

#### 3. Get Player's Invitations
```
GET /api/v1/players/invitations
Query: ?status=PENDING|ACCEPTED|REJECTED
```

#### 4. Accept Invitation (Player)
```
POST /api/v1/invitations/:invitationId/accept
```

#### 5. Reject Invitation (Player)
```
POST /api/v1/invitations/:invitationId/reject
```

#### 6. Cancel Invitation (Coach)
```
DELETE /api/v1/invitations/:invitationId
```

#### 7. Accept by Token (Public/Player)
```
POST /api/v1/invitations/accept/:token
Body: {
  playerId: string (optional if token is secure enough)
}
```

### Modified Endpoints

#### Remove Direct Add Player
```
DELETE /api/v1/teams/:id/players (remove this endpoint)
```

Or keep it but change behavior:
- Option A: Remove entirely - all additions must go through invitations
- Option B: Keep for backwards compatibility but mark as deprecated
- Option C: Keep but require invitation acceptance first

## Service Layer Changes

### New Service: InvitationService

```typescript
class InvitationService {
  // Create invitation
  static async createInvitation(teamId, data, userId)
  
  // List invitations for a team
  static async listTeamInvitations(teamId, filters, userId)
  
  // List invitations for a player
  static async listPlayerInvitations(playerId, filters)
  
  // Accept invitation
  static async acceptInvitation(invitationId, playerId)
  
  // Reject invitation
  static async rejectInvitation(invitationId, playerId)
  
  // Cancel invitation (coach only)
  static async cancelInvitation(invitationId, userId)
  
  // Generate secure token
  static generateInvitationToken()
  
  // Check and expire old invitations
  static async expireOldInvitations()
}
```

### Modified TeamService

```typescript
// Remove or modify addPlayer method
// Option 1: Remove entirely
// Option 2: Keep but require accepted invitation
static async addPlayer(teamId, invitationId, userId) {
  // Verify invitation exists and is accepted
  // Then add player to team
}
```

## Business Logic

### Invitation Flow

1. **Coach sends invitation:**
   - Coach selects player
   - System creates invitation with PENDING status
   - Generate secure token
   - Set expiration date (default 7 days)
   - Send notification (email/push) to player

2. **Player receives invitation:**
   - Player sees invitation in their invitations list
   - Can view team details, coach info, optional message

3. **Player accepts:**
   - Player accepts invitation
   - System creates TeamMember record
   - Invitation status → ACCEPTED
   - Set acceptedAt timestamp

4. **Player rejects:**
   - Player rejects invitation
   - Invitation status → REJECTED
   - Set rejectedAt timestamp
   - Coach can see rejection

5. **Invitation expires:**
   - Background job checks for expired invitations
   - Status → EXPIRED
   - Coach can resend if needed

### Validation Rules

- Only one PENDING invitation per team-player pair
- Coach can only invite to their own teams
- Player can only accept/reject their own invitations
- Invitations expire after set period (default 7 days)
- Cannot accept expired invitations
- Cannot accept already accepted/rejected invitations

## Mobile App Changes

### New Screens

1. **Invitations List (Player View)**
   - Show pending invitations
   - Show team info, coach name, message
   - Accept/Reject buttons

2. **Team Invitations (Coach View)**
   - List all invitations for a team
   - Show status (pending, accepted, rejected, expired)
   - Cancel pending invitations
   - Resend expired invitations

### Modified Screens

1. **Add Player to Team Screen**
   - Change "Add Player" to "Invite Player"
   - After selecting player, show invitation form
   - Optional message field
   - Send invitation instead of directly adding

2. **Team Details Screen**
   - Show pending invitations count
   - Link to invitations management

## Migration Strategy

### Option 1: Clean Break
- Remove direct add player endpoint
- Require all new additions via invitations
- Existing team members remain (grandfathered)

### Option 2: Gradual Migration
- Keep add player endpoint but mark deprecated
- Add invitation system alongside
- Migrate existing teams over time
- Eventually remove direct add

### Option 3: Hybrid
- Allow direct add for coaches (backwards compatible)
- But also support invitation flow
- Let coaches choose which method to use

## Security Considerations

1. **Invitation Tokens:**
   - Use cryptographically secure random tokens
   - Store hashed tokens in database
   - Tokens should be long enough to prevent brute force

2. **Authorization:**
   - Only coaches can create invitations for their teams
   - Only invited players can accept/reject their invitations
   - Only coaches can cancel invitations for their teams

3. **Rate Limiting:**
   - Limit invitations per coach per day
   - Prevent invitation spam

## Notification System (Future)

- Email notifications when invited
- Push notifications in mobile app
- In-app notification badges
- Email reminders for pending invitations

## Implementation Phases

### Phase 1: Core Invitation System
1. Database schema migration
2. InvitationService implementation
3. Basic API endpoints
4. Update TeamService to use invitations

### Phase 2: Mobile App Integration
1. Invitations list screen
2. Accept/Reject functionality
3. Update "Add Player" flow to send invitations

### Phase 3: Enhanced Features
1. Notification system
2. Invitation expiration job
3. Analytics and reporting

## Questions to Consider

1. **Should we allow coaches to directly add players?**
   - Pro: Faster for trusted relationships
   - Con: Bypasses player consent

2. **What about parents adding their children?**
   - Should parents be able to accept on behalf of players?
   - Need parent-player relationship model?

3. **Invitation expiration:**
   - How long should invitations last? (7 days? 30 days?)
   - Should coaches be notified when invitations expire?

4. **Multiple invitations:**
   - Can a player have multiple pending invitations from different teams?
   - Should we limit how many teams a player can join?

5. **Invitation messages:**
   - Required or optional?
   - Character limit?
