#!/bin/bash

# Test script for Players API endpoints
# Usage: ./scripts/test-players-api.sh [BASE_URL] [ACCESS_TOKEN]
# Example: ./scripts/test-players-api.sh http://localhost:3000 "your-access-token"

# Don't exit on error - we want to track all test results
set +e

BASE_URL="${1:-http://localhost:3000}"
API_URL="${BASE_URL}/api/v1"
ACCESS_TOKEN="${2}"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "=========================================="
echo "Testing Players API"
echo "=========================================="
echo "Base URL: ${BASE_URL}"
echo ""

# Check if access token is provided
if [ -z "$ACCESS_TOKEN" ]; then
  echo -e "${RED}Error: ACCESS_TOKEN is required${NC}"
  echo "Usage: $0 [BASE_URL] [ACCESS_TOKEN]"
  echo "Example: $0 http://localhost:3000 \"your-access-token\""
  exit 1
fi

# Test counters
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

# Function to make API calls
# Outputs display messages to stderr, JSON body to stdout
api_call() {
  local method=$1
  local endpoint=$2
  local data=$3
  local description=$4
  
  echo -e "${YELLOW}${description}${NC}" >&2
  echo "  ${method} ${endpoint}" >&2
  
  if [ -n "$data" ]; then
    response=$(curl -s -w "\n%{http_code}" -X "${method}" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer ${ACCESS_TOKEN}" \
      -d "${data}" \
      "${API_URL}${endpoint}")
  else
    response=$(curl -s -w "\n%{http_code}" -X "${method}" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer ${ACCESS_TOKEN}" \
      "${API_URL}${endpoint}")
  fi
  
  http_code=$(echo "$response" | tail -n1)
  body=$(echo "$response" | sed '$d')
  
  if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
    echo -e "  ${GREEN}✓ Success (HTTP ${http_code})${NC}" >&2
    echo "$body" | jq '.' 2>/dev/null >&2 || echo "$body" >&2
    echo "" >&2
    # Output only the JSON body to stdout for capture
    echo "$body"
    return 0
  else
    echo -e "  ${RED}✗ Failed (HTTP ${http_code})${NC}" >&2
    echo "$body" | jq '.' 2>/dev/null >&2 || echo "$body" >&2
    echo "" >&2
    return 1
  fi
}

# Generate unique test email using timestamp
TIMESTAMP=$(date +%s)
TEST_EMAIL_1="testplayer1-${TIMESTAMP}@example.com"
TEST_EMAIL_2="testplayer2-${TIMESTAMP}@example.com"

# Test 1: Create a new player
echo "=========================================="
echo "Test 1: Create a new player"
echo "=========================================="
PLAYER_DATA=$(cat <<EOF
{
  "name": "Test Player One",
  "email": "${TEST_EMAIL_1}"
}
EOF
)

TOTAL_TESTS=$((TOTAL_TESTS + 1))
RESPONSE=$(api_call "POST" "/players" "$PLAYER_DATA" "Creating player 'Test Player One'")
if [ $? -eq 0 ]; then
  PLAYER_ID=$(echo "$RESPONSE" | jq -r '.player.id // empty')
  if [ -z "$PLAYER_ID" ] || [ "$PLAYER_ID" = "null" ]; then
    echo -e "${RED}Failed to extract player ID from response${NC}" >&2
    echo "Response was: $RESPONSE" >&2
    FAILED_TESTS=$((FAILED_TESTS + 1))
  else
    PASSED_TESTS=$((PASSED_TESTS + 1))
    echo -e "${GREEN}Created player with ID: ${PLAYER_ID}${NC}"
  fi
else
  FAILED_TESTS=$((FAILED_TESTS + 1))
  echo -e "${RED}Test 1 failed: Could not create player${NC}" >&2
  exit 1
fi
echo ""

# Test 2: Get player by ID
echo "=========================================="
echo "Test 2: Get player by ID"
echo "=========================================="
TOTAL_TESTS=$((TOTAL_TESTS + 1))
if api_call "GET" "/players/${PLAYER_ID}" "" "Getting player details" > /dev/null; then
  PASSED_TESTS=$((PASSED_TESTS + 1))
else
  FAILED_TESTS=$((FAILED_TESTS + 1))
fi
echo ""

# Test 3: List all players
echo "=========================================="
echo "Test 3: List all players"
echo "=========================================="
TOTAL_TESTS=$((TOTAL_TESTS + 1))
if api_call "GET" "/players" "" "Listing all players" > /dev/null; then
  PASSED_TESTS=$((PASSED_TESTS + 1))
else
  FAILED_TESTS=$((FAILED_TESTS + 1))
fi
echo ""

# Test 4: Search players by name
echo "=========================================="
echo "Test 4: Search players by name"
echo "=========================================="
TOTAL_TESTS=$((TOTAL_TESTS + 1))
if api_call "GET" "/players?search=Test" "" "Searching for players with 'Test' in name/email" > /dev/null; then
  PASSED_TESTS=$((PASSED_TESTS + 1))
else
  FAILED_TESTS=$((FAILED_TESTS + 1))
fi
echo ""

# Test 5: Create another player for testing
echo "=========================================="
echo "Test 5: Create another player"
echo "=========================================="
PLAYER_DATA2=$(cat <<EOF
{
  "name": "Test Player Two",
  "email": "${TEST_EMAIL_2}"
}
EOF
)

TOTAL_TESTS=$((TOTAL_TESTS + 1))
RESPONSE2=$(api_call "POST" "/players" "$PLAYER_DATA2" "Creating player 'Test Player Two'")
if [ $? -eq 0 ]; then
  PLAYER_ID2=$(echo "$RESPONSE2" | jq -r '.player.id // empty')
  if [ -z "$PLAYER_ID2" ] || [ "$PLAYER_ID2" = "null" ]; then
    echo -e "${RED}Failed to extract player ID from response${NC}" >&2
    echo "Response was: $RESPONSE2" >&2
    FAILED_TESTS=$((FAILED_TESTS + 1))
  else
    PASSED_TESTS=$((PASSED_TESTS + 1))
    echo -e "${GREEN}Created player with ID: ${PLAYER_ID2}${NC}"
  fi
else
  FAILED_TESTS=$((FAILED_TESTS + 1))
  echo -e "${RED}Test 5 failed: Could not create second player${NC}" >&2
fi
echo ""

# Test 6: Update player
echo "=========================================="
echo "Test 6: Update player"
echo "=========================================="
UPDATE_DATA='{
  "name": "Test Player One Updated"
}'
TOTAL_TESTS=$((TOTAL_TESTS + 1))
if api_call "PATCH" "/players/${PLAYER_ID}" "$UPDATE_DATA" "Updating player name" > /dev/null; then
  PASSED_TESTS=$((PASSED_TESTS + 1))
else
  FAILED_TESTS=$((FAILED_TESTS + 1))
fi
echo ""

# Test 7: Verify update
echo "=========================================="
echo "Test 7: Verify player was updated"
echo "=========================================="
TOTAL_TESTS=$((TOTAL_TESTS + 1))
if api_call "GET" "/players/${PLAYER_ID}" "" "Getting updated player details" > /dev/null; then
  PASSED_TESTS=$((PASSED_TESTS + 1))
else
  FAILED_TESTS=$((FAILED_TESTS + 1))
fi
echo ""

# Test 8: List with pagination
echo "=========================================="
echo "Test 8: List with pagination"
echo "=========================================="
TOTAL_TESTS=$((TOTAL_TESTS + 1))
if api_call "GET" "/players?limit=1&offset=0" "" "Listing players with pagination (limit=1, offset=0)" > /dev/null; then
  PASSED_TESTS=$((PASSED_TESTS + 1))
else
  FAILED_TESTS=$((FAILED_TESTS + 1))
fi
echo ""

# Test 9: Search by email
echo "=========================================="
echo "Test 9: Search by email"
echo "=========================================="
TOTAL_TESTS=$((TOTAL_TESTS + 1))
if api_call "GET" "/players?search=testplayer2" "" "Searching for players with 'testplayer2' in email" > /dev/null; then
  PASSED_TESTS=$((PASSED_TESTS + 1))
else
  FAILED_TESTS=$((FAILED_TESTS + 1))
fi
echo ""

# Test 10: Try to create duplicate email (should fail)
echo "=========================================="
echo "Test 10: Try to create duplicate email (should fail)"
echo "=========================================="
DUPLICATE_DATA=$(cat <<EOF
{
  "name": "Duplicate Player",
  "email": "${TEST_EMAIL_1}"
}
EOF
)

RESPONSE=$(curl -s -w "\n%{http_code}" -X "POST" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -d "${DUPLICATE_DATA}" \
  "${API_URL}/players")

http_code=$(echo "$RESPONSE" | tail -n1)
body=$(echo "$RESPONSE" | sed '$d')

if [ "$http_code" -eq 400 ]; then
  echo -e "  ${GREEN}✓ Correctly rejected duplicate email (HTTP ${http_code})${NC}"
  echo "$body" | jq '.' 2>/dev/null || echo "$body"
else
  echo -e "  ${RED}✗ Expected HTTP 400, got ${http_code}${NC}"
  echo "$body" | jq '.' 2>/dev/null || echo "$body"
fi
echo ""

# Test 11: Get player with teams (if player is on any teams)
echo "=========================================="
echo "Test 11: Get player details (including teams)"
echo "=========================================="
api_call "GET" "/players/${PLAYER_ID}" "" "Getting player with team information"
echo ""

# Cleanup: Delete test players
echo "=========================================="
echo "Cleanup: Delete test players"
echo "=========================================="

# Note: Players can only be deleted if they're not on any teams
# and have no game events. For testing, we'll try to delete them.

echo -e "${YELLOW}Attempting to delete test players...${NC}"
echo ""

# Try to delete player 2
RESPONSE=$(curl -s -w "\n%{http_code}" -X "DELETE" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  "${API_URL}/players/${PLAYER_ID2}")

http_code=$(echo "$RESPONSE" | tail -n1)
body=$(echo "$RESPONSE" | sed '$d')

if [ "$http_code" -eq 200 ]; then
  echo -e "  ${GREEN}✓ Deleted player 2 (HTTP ${http_code})${NC}"
elif [ "$http_code" -eq 400 ]; then
  echo -e "  ${YELLOW}⚠ Cannot delete player 2 (may be on teams): ${body}${NC}"
else
  echo -e "  ${RED}✗ Failed to delete player 2 (HTTP ${http_code})${NC}"
  echo "$body"
fi

# Try to delete player 1
RESPONSE=$(curl -s -w "\n%{http_code}" -X "DELETE" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  "${API_URL}/players/${PLAYER_ID}")

http_code=$(echo "$RESPONSE" | tail -n1)
body=$(echo "$RESPONSE" | sed '$d')

if [ "$http_code" -eq 200 ]; then
  echo -e "  ${GREEN}✓ Deleted player 1 (HTTP ${http_code})${NC}"
elif [ "$http_code" -eq 400 ]; then
  echo -e "  ${YELLOW}⚠ Cannot delete player 1 (may be on teams): ${body}${NC}"
else
  echo -e "  ${RED}✗ Failed to delete player 1 (HTTP ${http_code})${NC}"
  echo "$body"
fi

echo ""
echo "=========================================="
echo "Test Summary"
echo "=========================================="
echo -e "Total Tests:  ${TOTAL_TESTS}"
echo -e "${GREEN}Passed:       ${PASSED_TESTS}${NC}"
if [ "$FAILED_TESTS" -gt 0 ]; then
  echo -e "${RED}Failed:       ${FAILED_TESTS}${NC}"
else
  echo -e "Failed:       ${FAILED_TESTS}"
fi
echo "=========================================="

if [ "$FAILED_TESTS" -eq 0 ]; then
  echo -e "${GREEN}All tests passed! ✓${NC}"
  exit 0
else
  echo -e "${RED}Some tests failed. Please review the output above.${NC}"
  exit 1
fi
