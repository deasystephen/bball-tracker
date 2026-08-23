#!/bin/bash

# Full Flow Testing Script (local dev backend)
# Tests the complete flow against the CURRENT API:
#   League (ADMIN) → Season → Team (COACH) → Managed roster player → Game → Event → verify
#
# Usage:
#   ./scripts/test-full-flow.sh                      # dev-login as the seeded admin (NODE_ENV=development)
#   TOKEN="<access token>" ./scripts/test-full-flow.sh   # use a real WorkOS access token (must be ADMIN)
#   API_BASE=http://localhost:3000/api/v1 DEV_LOGIN_EMAIL=admin@bball-tracker.com ./scripts/test-full-flow.sh
#
# Requires an ADMIN account because `POST /leagues` is ADMIN-only; ADMIN also bypasses the
# COACH requirement and the FREE-tier team cap on `POST /teams`. The seeded admin
# (`npx prisma db seed`) is admin@bball-tracker.com. Never point this at production.

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
API_BASE="${API_BASE:-http://localhost:3000/api/v1}"
TOKEN="${TOKEN:-}"
DEV_LOGIN_EMAIL="${DEV_LOGIN_EMAIL:-admin@bball-tracker.com}"

if ! command -v jq &> /dev/null; then
    echo -e "${RED}✗ jq is required (brew install jq)${NC}"
    exit 1
fi

# Functions
print_step() {
    echo -e "\n${BLUE}▶ $1${NC}"
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

# Make API request
api_request() {
    local method=$1
    local endpoint=$2
    local data=$3

    if [ -z "$data" ]; then
        curl -s -X "$method" \
            -H "Authorization: Bearer $TOKEN" \
            -H "Content-Type: application/json" \
            "$API_BASE$endpoint"
    else
        curl -s -X "$method" \
            -H "Authorization: Bearer $TOKEN" \
            -H "Content-Type: application/json" \
            -d "$data" \
            "$API_BASE$endpoint"
    fi
}

# Check if server is running
check_server() {
    print_step "Checking if server is running..."
    local health_url="${API_BASE%/api/v1}/health"
    if curl -s -f "$health_url" > /dev/null 2>&1; then
        print_success "Server is running ($health_url)"
    else
        print_error "Server is not running at $health_url"
        echo "Please start the server with: cd backend && npm run dev"
        exit 1
    fi
}

# Get a token: dev-login (development only) unless TOKEN was supplied
get_token() {
    if [ -z "$TOKEN" ]; then
        print_step "Dev-login as $DEV_LOGIN_EMAIL (requires NODE_ENV=development)..."
        local login_response
        login_response=$(curl -s -X POST -H "Content-Type: application/json" \
            -d "{\"email\":\"$DEV_LOGIN_EMAIL\"}" "$API_BASE/auth/dev-login")
        TOKEN=$(echo "$login_response" | jq -r '.accessToken // empty')
        if [ -z "$TOKEN" ]; then
            print_error "Dev-login failed. Seed the DB (npx prisma db seed) or pass TOKEN=<WorkOS access token>."
            echo "Response: $login_response"
            exit 1
        fi
        print_success "Dev token obtained"
    fi

    print_step "Validating token..."
    local response
    response=$(api_request "GET" "/auth/me")
    if [ "$(echo "$response" | jq -r '.success // false')" != "true" ]; then
        print_error "Invalid token. Please check your token and try again."
        echo "Response: $response"
        exit 1
    fi
    print_success "Token is valid"
}

# Main test flow
main() {
    echo -e "${BLUE}"
    echo "╔══════════════════════════════════════════════════════════╗"
    echo "║     Basketball Tracker - Full Flow Test                  ║"
    echo "║     League → Season → Team → Roster → Game → Event      ║"
    echo "╚══════════════════════════════════════════════════════════╝"
    echo -e "${NC}"

    check_server
    get_token

    # Step 1: Get User ID
    print_step "Step 1: Getting user information..."
    user_response=$(api_request "GET" "/auth/me")
    USER_ID=$(echo "$user_response" | jq -r '.user.id // empty')
    USER_NAME=$(echo "$user_response" | jq -r '.user.name // empty')
    USER_ROLE=$(echo "$user_response" | jq -r '.user.role // empty')

    if [ -z "$USER_ID" ]; then
        print_error "Failed to get user ID"
        echo "Response: $user_response"
        exit 1
    fi
    print_success "User: $USER_NAME (ID: $USER_ID, role: $USER_ROLE)"
    if [ "$USER_ROLE" != "ADMIN" ]; then
        print_warning "User is not ADMIN — POST /leagues will return 403"
    fi

    # Step 2: Create League (ADMIN only; id is a slug derived from the name)
    print_step "Step 2: Creating league..."
    league_data="{\"name\": \"Test League $(date +%s)\"}"
    league_response=$(api_request "POST" "/leagues" "$league_data")
    LEAGUE_ID=$(echo "$league_response" | jq -r '.league.id // empty')
    if [ -z "$LEAGUE_ID" ]; then
        print_error "Failed to create league"
        echo "Response: $league_response"
        exit 1
    fi
    print_success "League created: $(echo "$league_response" | jq -r '.league.name') (ID: $LEAGUE_ID)"

    # Step 3: Create Season (teams must belong to a season)
    print_step "Step 3: Creating season..."
    season_data="{\"leagueId\": \"$LEAGUE_ID\", \"name\": \"Test Season\"}"
    season_response=$(api_request "POST" "/seasons" "$season_data")
    SEASON_ID=$(echo "$season_response" | jq -r '.season.id // empty')
    if [ -z "$SEASON_ID" ]; then
        print_error "Failed to create season"
        echo "Response: $season_response"
        exit 1
    fi
    print_success "Season created: Test Season (ID: $SEASON_ID)"

    # Step 4: Create Team (COACH / ADMIN / league admin; creator becomes Head Coach)
    print_step "Step 4: Creating team..."
    team_data="{\"name\": \"Thunder\", \"seasonId\": \"$SEASON_ID\"}"
    team_response=$(api_request "POST" "/teams" "$team_data")
    TEAM_ID=$(echo "$team_response" | jq -r '.team.id // empty')
    if [ -z "$TEAM_ID" ]; then
        print_error "Failed to create team (COACH role or ADMIN required; FREE tier is capped at 3 teams → 402)"
        echo "Response: $team_response"
        exit 1
    fi
    print_success "Team created: $(echo "$team_response" | jq -r '.team.name') (ID: $TEAM_ID)"

    # Step 5: Add a managed roster player (no email / account needed)
    # POST /teams/:id/players is gone (410) — real users join via invitations.
    print_step "Step 5: Adding managed roster player..."
    player_data='{"name": "Test Player 1", "jerseyNumber": 23, "position": "Forward"}'
    player_response=$(api_request "POST" "/teams/$TEAM_ID/managed-players" "$player_data")
    PLAYER_ID=$(echo "$player_response" | jq -r '.teamMember.playerId // .teamMember.player.id // empty')
    if [ -z "$PLAYER_ID" ]; then
        print_error "Failed to add managed player"
        echo "Response: $player_response"
        exit 1
    fi
    print_success "Managed player added (ID: $PLAYER_ID)"

    # Step 6: Create Game
    print_step "Step 6: Creating game..."
    game_date=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    game_data="{\"teamId\": \"$TEAM_ID\", \"opponent\": \"Lakers\", \"date\": \"$game_date\"}"
    game_response=$(api_request "POST" "/games" "$game_data")
    GAME_ID=$(echo "$game_response" | jq -r '.game.id // empty')
    if [ -z "$GAME_ID" ]; then
        print_error "Failed to create game"
        echo "Response: $game_response"
        exit 1
    fi
    print_success "Game created: vs $(echo "$game_response" | jq -r '.game.opponent') (ID: $GAME_ID, status $(echo "$game_response" | jq -r '.game.status'))"

    # Step 7: Start the game and record a made 2-pointer (score is server-derived)
    print_step "Step 7: Starting game and recording a made shot..."
    start_response=$(api_request "PATCH" "/games/$GAME_ID" '{"status": "IN_PROGRESS"}')
    if [ "$(echo "$start_response" | jq -r '.game.status // empty')" != "IN_PROGRESS" ]; then
        print_error "Failed to start game"
        echo "Response: $start_response"
        exit 1
    fi
    event_data="{\"playerId\": \"$PLAYER_ID\", \"eventType\": \"SHOT\", \"metadata\": {\"made\": true, \"points\": 2}}"
    event_response=$(api_request "POST" "/games/$GAME_ID/events" "$event_data")
    HOME_SCORE=$(echo "$event_response" | jq -r '.score.homeScore // empty')
    if [ "$HOME_SCORE" != "2" ]; then
        print_error "Expected score.homeScore == 2 after a made 2-pointer"
        echo "Response: $event_response"
        exit 1
    fi
    print_success "Event recorded; server-derived score is $HOME_SCORE-$(echo "$event_response" | jq -r '.score.awayScore')"

    # Step 8: Verify Everything
    print_step "Step 8: Verifying created resources..."
    for pair in "League:/leagues/$LEAGUE_ID:$LEAGUE_ID" "Season:/seasons/$SEASON_ID:$SEASON_ID" \
                "Team:/teams/$TEAM_ID:$TEAM_ID" "Game:/games/$GAME_ID:$GAME_ID"; do
        label=${pair%%:*}; rest=${pair#*:}; path=${rest%%:*}; id=${rest#*:}
        if api_request "GET" "$path" | grep -q "$id"; then
            print_success "$label verified"
        else
            print_warning "$label verification failed"
        fi
    done
    if api_request "GET" "/games/$GAME_ID" | jq -e '.game.homeScore == 2' > /dev/null; then
        print_success "Game detail shows homeScore 2"
    else
        print_warning "Game detail homeScore mismatch"
    fi

    # Summary
    echo ""
    echo -e "${GREEN}╔══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║                    Test Complete!                        ║${NC}"
    echo -e "${GREEN}╚══════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo "Created Resources:"
    echo "  League ID:  $LEAGUE_ID"
    echo "  Season ID:  $SEASON_ID"
    echo "  Team ID:    $TEAM_ID"
    echo "  Player ID:  $PLAYER_ID"
    echo "  Game ID:    $GAME_ID"
    echo ""
    echo "Clean up with: DELETE $API_BASE/leagues/$LEAGUE_ID (cascades)"
    echo ""
}

# Run main function
main
