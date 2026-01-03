#!/bin/bash

# Full Flow Testing Script
# Tests the complete flow: League → Team → Players → Game

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
API_BASE="http://localhost:3000/api/v1"
TOKEN=""

# Check if jq is available
HAS_JQ=false
if command -v jq &> /dev/null; then
    HAS_JQ=true
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

# Extract JSON value (works with or without jq)
extract_json() {
    local key=$1
    local json=$2
    
    if [ "$HAS_JQ" = true ]; then
        echo "$json" | jq -r "$key"
    else
        # Simple grep/sed extraction (less robust but works for simple cases)
        echo "$json" | grep -o "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | sed "s/\"$key\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\"/\1/"
    fi
}

# Extract nested JSON value with jq
extract_nested_json() {
    local path=$1
    local json=$2
    
    if [ "$HAS_JQ" = true ]; then
        echo "$json" | jq -r "$path"
    else
        print_warning "jq not available, using fallback extraction"
        # Fallback: try to extract from common patterns
        if [[ "$path" == *".id" ]]; then
            local key=$(echo "$path" | sed 's/.*\.\([^.]*\)$/\1/')
            extract_json "$key" "$json"
        else
            echo ""
        fi
    fi
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
    if curl -s -f "$API_BASE" > /dev/null 2>&1; then
        print_success "Server is running"
    else
        print_error "Server is not running at $API_BASE"
        echo "Please start the server with: cd backend && npm run dev"
        exit 1
    fi
}

# Get token from user
get_token() {
    if [ -z "$TOKEN" ]; then
        echo ""
        print_warning "WorkOS access token is required"
        echo "You can get a token by:"
        echo "  1. Visit: http://localhost:3000/api/v1/auth/login?format=json"
        echo "  2. Authenticate with WorkOS"
        echo "  3. Copy the accessToken from the callback response"
        echo ""
        read -p "Enter your WorkOS access token: " TOKEN
        
        if [ -z "$TOKEN" ]; then
            print_error "Token is required"
            exit 1
        fi
    fi
    
    # Test token
    print_step "Validating token..."
    response=$(api_request "GET" "/auth/me")
    
    if echo "$response" | grep -q "error"; then
        print_error "Invalid token. Please check your token and try again."
        exit 1
    fi
    
    print_success "Token is valid"
}

# Main test flow
main() {
    echo -e "${BLUE}"
    echo "╔══════════════════════════════════════════════════════════╗"
    echo "║     Basketball Tracker - Full Flow Test                  ║"
    echo "║     League → Team → Players → Game                      ║"
    echo "╚══════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
    
    # Check prerequisites
    check_server
    get_token
    
    # Step 1: Get User ID
    print_step "Step 1: Getting user information..."
    user_response=$(api_request "GET" "/auth/me")
    USER_ID=$(extract_nested_json ".user.id" "$user_response")
    USER_NAME=$(extract_nested_json ".user.name" "$user_response")
    
    if [ -z "$USER_ID" ] || [ "$USER_ID" == "null" ]; then
        print_error "Failed to get user ID"
        echo "Response: $user_response"
        exit 1
    fi
    
    print_success "User: $USER_NAME (ID: $USER_ID)"
    
    # Step 2: Create League
    print_step "Step 2: Creating league..."
    league_data='{
        "name": "Test League '$(date +%s)'",
        "season": "Winter 2024",
        "year": 2024
    }'
    
    league_response=$(api_request "POST" "/leagues" "$league_data")
    LEAGUE_ID=$(extract_nested_json ".league.id" "$league_response")
    
    if [ -z "$LEAGUE_ID" ] || [ "$LEAGUE_ID" == "null" ]; then
        print_error "Failed to create league"
        echo "Response: $league_response"
        exit 1
    fi
    
    LEAGUE_NAME=$(extract_nested_json ".league.name" "$league_response")
    print_success "League created: $LEAGUE_NAME (ID: $LEAGUE_ID)"
    
    # Step 3: Create Team
    print_step "Step 3: Creating team..."
    team_data="{
        \"name\": \"Thunder\",
        \"leagueId\": \"$LEAGUE_ID\"
    }"
    
    team_response=$(api_request "POST" "/teams" "$team_data")
    TEAM_ID=$(extract_nested_json ".team.id" "$team_response")
    
    if [ -z "$TEAM_ID" ] || [ "$TEAM_ID" == "null" ]; then
        print_error "Failed to create team"
        echo "Response: $team_response"
        exit 1
    fi
    
    TEAM_NAME=$(extract_nested_json ".team.name" "$team_response")
    print_success "Team created: $TEAM_NAME (ID: $TEAM_ID)"
    
    # Step 4: Add Player to Team
    print_step "Step 4: Adding player to team..."
    player_data="{
        \"playerId\": \"$USER_ID\",
        \"jerseyNumber\": 23,
        \"position\": \"Forward\"
    }"
    
    player_response=$(api_request "POST" "/teams/$TEAM_ID/players" "$player_data")
    
    if echo "$player_response" | grep -q "error"; then
        print_warning "Failed to add player (may already be on team)"
        echo "Response: $player_response"
    else
        print_success "Player added to team"
    fi
    
    # Step 5: Create Game
    print_step "Step 5: Creating game..."
    game_date=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%S" 2>/dev/null || echo "2024-01-15T18:00:00Z")
    game_data="{
        \"teamId\": \"$TEAM_ID\",
        \"opponent\": \"Lakers\",
        \"date\": \"$game_date\",
        \"status\": \"SCHEDULED\",
        \"homeScore\": 0,
        \"awayScore\": 0
    }"
    
    game_response=$(api_request "POST" "/games" "$game_data")
    GAME_ID=$(extract_nested_json ".game.id" "$game_response")
    
    if [ -z "$GAME_ID" ] || [ "$GAME_ID" == "null" ]; then
        print_error "Failed to create game"
        echo "Response: $game_response"
        exit 1
    fi
    
    OPPONENT=$(extract_nested_json ".game.opponent" "$game_response")
    print_success "Game created: vs $OPPONENT (ID: $GAME_ID)"
    
    # Step 6: Verify Everything
    print_step "Step 6: Verifying created resources..."
    
    # Verify League
    league_get=$(api_request "GET" "/leagues/$LEAGUE_ID")
    if echo "$league_get" | grep -q "$LEAGUE_ID"; then
        print_success "League verified"
    else
        print_warning "League verification failed"
    fi
    
    # Verify Team
    team_get=$(api_request "GET" "/teams/$TEAM_ID")
    if echo "$team_get" | grep -q "$TEAM_ID"; then
        print_success "Team verified"
    else
        print_warning "Team verification failed"
    fi
    
    # Verify Game
    game_get=$(api_request "GET" "/games/$GAME_ID")
    if echo "$game_get" | grep -q "$GAME_ID"; then
        print_success "Game verified"
    else
        print_warning "Game verification failed"
    fi
    
    # Summary
    echo ""
    echo -e "${GREEN}╔══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║                    Test Complete!                        ║${NC}"
    echo -e "${GREEN}╚══════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo "Created Resources:"
    echo "  League ID: $LEAGUE_ID"
    echo "  Team ID:   $TEAM_ID"
    echo "  Game ID:   $GAME_ID"
    echo ""
    echo "You can verify these in your database or via the API:"
    echo "  GET $API_BASE/leagues/$LEAGUE_ID"
    echo "  GET $API_BASE/teams/$TEAM_ID"
    echo "  GET $API_BASE/games/$GAME_ID"
    echo ""
}

# Run main function
main
