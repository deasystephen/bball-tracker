#!/bin/bash

# Test script for the Players API (`/api/v1/players`) against a local dev backend.
#
# Usage: ./scripts/test-players-api.sh [BASE_URL] [ACCESS_TOKEN]
# Example: ./scripts/test-players-api.sh http://localhost:3000 "your-access-token"
#
# The token MUST belong to a system ADMIN:
#   - POST /players (pre-create an account for an email) is ADMIN or roster-managing staff only (403 otherwise)
#   - GET /players is scoped to the caller's teams for everyone but ADMIN, and `search` matches
#     email only for ADMIN (non-admins: name only, and `email` is omitted from list results)
#   - DELETE /players/:id of an un-rostered player older than the 24h grace window is ADMIN-only
# With no ACCESS_TOKEN and a backend running with NODE_ENV=development, the script dev-logins as
# the seeded admin (admin@bball-tracker.com, `npx prisma db seed`). Never point this at production.

# Don't exit on error - we want to track all test results
set +e

BASE_URL="${1:-http://localhost:3000}"
API_URL="${BASE_URL}/api/v1"
ACCESS_TOKEN="${2}"
DEV_LOGIN_EMAIL="${DEV_LOGIN_EMAIL:-admin@bball-tracker.com}"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

if ! command -v jq &> /dev/null; then
  echo -e "${RED}Error: jq is required (brew install jq)${NC}"
  exit 1
fi

echo "=========================================="
echo "Testing Players API"
echo "=========================================="
echo "Base URL: ${BASE_URL}"
echo ""

# Dev-login if no token was provided (development backend only)
if [ -z "$ACCESS_TOKEN" ]; then
  echo -e "${YELLOW}No token given — dev-login as ${DEV_LOGIN_EMAIL} (requires NODE_ENV=development)${NC}"
  ACCESS_TOKEN=$(curl -s -X POST -H "Content-Type: application/json" \
    -d "{\"email\":\"${DEV_LOGIN_EMAIL}\"}" "${API_URL}/auth/dev-login" | jq -r '.accessToken // empty')
  if [ -z "$ACCESS_TOKEN" ]; then
    echo -e "${RED}Error: dev-login failed and no ACCESS_TOKEN was provided${NC}"
    echo "Usage: $0 [BASE_URL] [ACCESS_TOKEN]"
    exit 1
  fi
fi

ME=$(curl -s -H "Authorization: Bearer ${ACCESS_TOKEN}" "${API_URL}/auth/me")
ROLE=$(echo "$ME" | jq -r '.user.role // empty')
if [ "$ROLE" != "ADMIN" ]; then
  echo -e "${RED}Error: token belongs to role '${ROLE:-unknown}', but this script needs a system ADMIN${NC}"
  echo "$ME" | jq '.' 2>/dev/null
  exit 1
fi
echo -e "${GREEN}Authenticated as $(echo "$ME" | jq -r '.user.email') (ADMIN)${NC}"
echo ""

# Test counters
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

pass() { PASSED_TESTS=$((PASSED_TESTS + 1)); }
fail() { FAILED_TESTS=$((FAILED_TESTS + 1)); }

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

# Expect a specific non-2xx status
expect_status() {
  local method=$1
  local endpoint=$2
  local data=$3
  local expected=$4
  local description=$5

  echo -e "${YELLOW}${description}${NC}"
  echo "  ${method} ${endpoint} (expect HTTP ${expected})"
  if [ -n "$data" ]; then
    response=$(curl -s -w "\n%{http_code}" -X "${method}" -H "Content-Type: application/json" \
      -H "Authorization: Bearer ${ACCESS_TOKEN}" -d "${data}" "${API_URL}${endpoint}")
  else
    response=$(curl -s -w "\n%{http_code}" -X "${method}" \
      -H "Authorization: Bearer ${ACCESS_TOKEN}" "${API_URL}${endpoint}")
  fi
  http_code=$(echo "$response" | tail -n1)
  body=$(echo "$response" | sed '$d')
  TOTAL_TESTS=$((TOTAL_TESTS + 1))
  if [ "$http_code" -eq "$expected" ]; then
    echo -e "  ${GREEN}✓ Got HTTP ${http_code}${NC}"
    pass
  else
    echo -e "  ${RED}✗ Expected HTTP ${expected}, got ${http_code}${NC}"
    fail
  fi
  echo "$body" | jq '.' 2>/dev/null || echo "$body"
  echo ""
}

# Generate unique test email using timestamp
TIMESTAMP=$(date +%s)
TEST_EMAIL_1="testplayer1-${TIMESTAMP}@example.com"
TEST_EMAIL_2="testplayer2-${TIMESTAMP}@example.com"

# Test 1: Create a new player (pre-provisioned account, role PLAYER, claimed on first WorkOS sign-in)
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
  if [ -z "$PLAYER_ID" ]; then
    echo -e "${RED}Failed to extract player ID from response${NC}" >&2
    echo "Response was: $RESPONSE" >&2
    fail
  else
    pass
    echo -e "${GREEN}Created player with ID: ${PLAYER_ID}${NC}"
  fi
else
  fail
  echo -e "${RED}Test 1 failed: Could not create player${NC}" >&2
  exit 1
fi
echo ""

# Test 2: Get player by ID (ADMIN sees email)
echo "=========================================="
echo "Test 2: Get player by ID"
echo "=========================================="
TOTAL_TESTS=$((TOTAL_TESTS + 1))
RESPONSE=$(api_call "GET" "/players/${PLAYER_ID}" "" "Getting player details")
if [ $? -eq 0 ] && [ "$(echo "$RESPONSE" | jq -r '.player.email')" = "$TEST_EMAIL_1" ]; then
  pass
else
  echo -e "${RED}Expected player.email == ${TEST_EMAIL_1} for an ADMIN caller${NC}" >&2
  fail
fi
echo ""

# Test 3: List players (ADMIN: unscoped, paginated { players, total })
echo "=========================================="
echo "Test 3: List all players"
echo "=========================================="
TOTAL_TESTS=$((TOTAL_TESTS + 1))
if api_call "GET" "/players" "" "Listing players (admin: unscoped)" > /dev/null; then
  pass
else
  fail
fi
echo ""

# Test 4: Search players by name
echo "=========================================="
echo "Test 4: Search players by name"
echo "=========================================="
TOTAL_TESTS=$((TOTAL_TESTS + 1))
RESPONSE=$(api_call "GET" "/players?search=Test%20Player" "" "Searching for players with 'Test Player' in name")
if [ $? -eq 0 ] && echo "$RESPONSE" | jq -e --arg id "$PLAYER_ID" '.players[] | select(.id == $id)' > /dev/null; then
  pass
else
  echo -e "${RED}Created player not found in search results${NC}" >&2
  fail
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
  if [ -z "$PLAYER_ID2" ]; then
    echo -e "${RED}Failed to extract player ID from response${NC}" >&2
    echo "Response was: $RESPONSE2" >&2
    fail
  else
    pass
    echo -e "${GREEN}Created player with ID: ${PLAYER_ID2}${NC}"
  fi
else
  fail
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
  pass
else
  fail
fi
echo ""

# Test 7: Verify update
echo "=========================================="
echo "Test 7: Verify player was updated"
echo "=========================================="
TOTAL_TESTS=$((TOTAL_TESTS + 1))
RESPONSE=$(api_call "GET" "/players/${PLAYER_ID}" "" "Getting updated player details")
if [ $? -eq 0 ] && [ "$(echo "$RESPONSE" | jq -r '.player.name')" = "Test Player One Updated" ]; then
  pass
else
  echo -e "${RED}Name was not updated${NC}" >&2
  fail
fi
echo ""

# Test 8: List with pagination (limit defaults to 20, max 100)
echo "=========================================="
echo "Test 8: List with pagination"
echo "=========================================="
TOTAL_TESTS=$((TOTAL_TESTS + 1))
RESPONSE=$(api_call "GET" "/players?limit=1&offset=0" "" "Listing players with pagination (limit=1, offset=0)")
if [ $? -eq 0 ] && [ "$(echo "$RESPONSE" | jq -r '.players | length')" = "1" ]; then
  pass
else
  echo -e "${RED}Expected exactly one player in the page${NC}" >&2
  fail
fi
echo ""

# Test 9: Search by email (ADMIN only — non-admin search matches name only)
echo "=========================================="
echo "Test 9: Search by email (admin)"
echo "=========================================="
TOTAL_TESTS=$((TOTAL_TESTS + 1))
RESPONSE=$(api_call "GET" "/players?search=testplayer2-${TIMESTAMP}" "" "Searching for players with 'testplayer2-${TIMESTAMP}' in email")
if [ $? -eq 0 ] && echo "$RESPONSE" | jq -e --arg id "$PLAYER_ID2" '.players[] | select(.id == $id)' > /dev/null; then
  pass
else
  echo -e "${RED}Second player not found by email search${NC}" >&2
  fail
fi
echo ""

# Test 10: Duplicate email is rejected (400 from the pre-check; 409 if the unique index wins a race)
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
expect_status "POST" "/players" "$DUPLICATE_DATA" 400 "Creating a player with an email that already exists"

# Test 11: Unknown id is a 404 (ids can't be enumerated)
echo "=========================================="
echo "Test 11: Unknown player id"
echo "=========================================="
expect_status "GET" "/players/00000000-0000-4000-8000-000000000000" "" 404 "Getting a player that does not exist"

# Cleanup: Delete test players (ADMIN may delete; players on a team or with events are refused with 400)
echo "=========================================="
echo "Cleanup: Delete test players"
echo "=========================================="
for ID in "$PLAYER_ID2" "$PLAYER_ID"; do
  [ -z "$ID" ] && continue
  RESPONSE=$(curl -s -w "\n%{http_code}" -X "DELETE" \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    "${API_URL}/players/${ID}")
  http_code=$(echo "$RESPONSE" | tail -n1)
  body=$(echo "$RESPONSE" | sed '$d')
  if [ "$http_code" -eq 200 ]; then
    echo -e "  ${GREEN}✓ Deleted player ${ID} (HTTP ${http_code})${NC}"
  elif [ "$http_code" -eq 400 ]; then
    echo -e "  ${YELLOW}⚠ Cannot delete player ${ID} (on a team / has events): ${body}${NC}"
  else
    echo -e "  ${RED}✗ Failed to delete player ${ID} (HTTP ${http_code})${NC}"
    echo "$body"
  fi
done

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
