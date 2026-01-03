# Testing Guide - Teams Management UI

## Prerequisites

### 1. Backend Setup
Ensure your backend is running and accessible:

```bash
# From the backend directory
cd ../backend
npm run dev
```

The backend should be running on `http://localhost:3000` (or `http://127.0.0.1:3000` for iOS Simulator).

**Verify backend is running:**
- Open `http://localhost:3000/api/v1` in your browser
- You should see: `{"message":"API v1"}`

### 2. Database Setup
Make sure your database is running and migrations are applied:

```bash
# From the backend directory
npx prisma migrate dev
npx prisma generate
```

### 3. WorkOS Configuration
Ensure your `.env` file in the backend has:
- `WORKOS_API_KEY`
- `WORKOS_CLIENT_ID`
- `WORKOS_REDIRECT_URI` (should include mobile deep link support)

## Mobile App Setup

### 1. Install Dependencies

```bash
cd mobile
npm install
```

### 2. Start Expo Development Server

```bash
npm start
```

This will:
- Start the Metro bundler
- Open Expo DevTools in your browser
- Show a QR code for testing on physical devices

### 3. Run on iOS Simulator

```bash
npm run ios
```

Or press `i` in the Expo CLI terminal.

**Note:** The app is configured to use `http://127.0.0.1:3000` for iOS Simulator (required for localhost access).

### 4. Run on Android Emulator

```bash
npm run android
```

Or press `a` in the Expo CLI terminal.

**Note:** Android emulator uses `http://localhost:3000` or `http://10.0.2.2:3000`.

### 5. Run on Physical Device

1. Install **Expo Go** app from App Store (iOS) or Play Store (Android)
2. Scan the QR code shown in the Expo CLI terminal
3. The app will load on your device

**Important:** For physical devices, you'll need to:
- Use your computer's local IP address instead of localhost
- Update the API URL in `mobile/services/api-client.ts` or use environment variables

## Testing Workflow

### Step 1: Authentication

1. **Login Screen**
   - Tap "Sign In" button
   - Should open WorkOS authentication in browser
   - Complete email/password signup or login
   - Should redirect back to app with authentication token

2. **Verify Authentication**
   - After login, you should see the main tabs (Home, Teams, etc.)
   - Check that user info is displayed correctly

### Step 2: Create a League (if needed)

Before creating teams, you may need at least one league:

1. Navigate to Leagues tab (if available)
2. Create a test league with:
   - Name: "Test League"
   - Season: "Winter"
   - Year: 2024

### Step 3: Teams List Screen

1. **Navigate to Teams Tab**
   - Tap the "Teams" tab in bottom navigation
   - Should show empty state if no teams exist

2. **Empty State**
   - Verify "No teams found" message
   - Verify "Create New Team" button is visible

3. **Pull to Refresh**
   - Pull down on the list
   - Should show loading indicator
   - Should refresh the list

### Step 4: Create Team

1. **Open Create Screen**
   - Tap "Create New Team" button (or FAB if visible)
   - Should navigate to create team screen

2. **Fill Form**
   - Enter team name: "Test Team"
   - Select a league from the buttons
   - Verify validation (try submitting empty form)

3. **Submit**
   - Tap "Create Team" button
   - Should show loading state
   - Should navigate back to teams list
   - New team should appear in the list

### Step 5: View Team Details

1. **Navigate to Team**
   - Tap on a team card in the list
   - Should navigate to team details screen

2. **Verify Information**
   - Team name is displayed
   - League information is shown
   - Coach information is displayed
   - Players list is shown (may be empty)

3. **Actions**
   - Verify "Edit" button is visible (if you're the coach)
   - Verify "Delete" button is visible (if you're the coach)
   - Verify "Manage Players" button is visible

### Step 6: Edit Team

1. **Open Edit Screen**
   - Tap "Edit" button on team details
   - Should navigate to edit screen with pre-filled form

2. **Modify Team**
   - Change team name
   - Change league selection
   - Tap "Save"

3. **Verify Changes**
   - Should navigate back to team details
   - Changes should be reflected
   - Navigate back to teams list
   - Changes should be visible in list

### Step 7: Manage Players

1. **Open Players Screen**
   - From team details, tap "Manage Players"
   - Should navigate to players management screen

2. **Add Player**
   - Enter player email/ID
   - Enter jersey number (optional)
   - Enter position (optional)
   - Tap "Add Player"
   - Should add player to list

3. **Remove Player**
   - Tap remove button on a player
   - Confirm deletion
   - Player should be removed from list

### Step 8: Delete Team

1. **Delete from Details**
   - Navigate to team details
   - Tap "Delete" button
   - Confirm deletion
   - Should navigate back to teams list
   - Team should be removed

## Testing Responsive Design

### iPhone Testing
- Verify single column layout for teams list
- Check spacing and padding on smaller screen
- Test navigation and scrolling

### iPad Testing
- Verify two-column grid layout for teams list
- Check wider spacing and padding
- Test landscape orientation (if supported)

## Testing Dark Mode

1. **Toggle Theme**
   - Go to Settings/Profile (if theme toggle exists)
   - Or change system theme on device
   - App should adapt to dark mode

2. **Verify Components**
   - All screens should have proper dark mode colors
   - Text should be readable
   - Cards and buttons should have proper contrast

## Testing Internationalization

1. **Change Device Language**
   - iOS: Settings > General > Language & Region
   - Android: Settings > System > Languages
   - App should detect and use device language

2. **Verify Translations**
   - All text should be in selected language
   - Buttons, labels, and messages should be translated

## Common Issues & Solutions

### Issue: "Network Error" or "Cannot connect to API"
**Solution:**
- Verify backend is running on port 3000
- For iOS Simulator, ensure API URL uses `127.0.0.1` not `localhost`
- Check CORS settings in backend

### Issue: "Unauthorized" errors
**Solution:**
- Re-authenticate by logging out and back in
- Check that WorkOS tokens are being stored correctly
- Verify backend authentication middleware

### Issue: Teams list is empty after creating team
**Solution:**
- Pull to refresh the list
- Check backend logs for errors
- Verify team was created in database

### Issue: Can't see "Edit" or "Delete" buttons
**Solution:**
- Verify you're logged in as the team's coach
- Check role-based authorization in backend
- Verify user ID matches team coach ID

## Debugging Tips

### View API Calls
- Open React Native Debugger
- Check Network tab in browser DevTools (if using web)
- Check backend console logs

### View State
- Use React DevTools
- Check Zustand store state
- Check TanStack Query cache

### View Logs
```bash
# Mobile app logs
npx expo start --clear

# Backend logs
# Check terminal where backend is running
```

## Next Steps

After testing Teams management:
1. Test Leagues management (when built)
2. Test Games management (when built)
3. Test real-time updates (WebSocket)
4. Test offline functionality
5. Test error handling and edge cases
