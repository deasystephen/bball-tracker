# Basketball Tracker Mobile App

React Native mobile application built with Expo for iOS and Android.

## Tech Stack

- **Framework**: React Native with Expo
- **Navigation**: Expo Router (file-based routing)
- **State Management**: 
  - Zustand (client state)
  - TanStack Query (server state)
- **HTTP Client**: Axios
- **Storage**: AsyncStorage (via Zustand persist)

## Setup

### Prerequisites

- Node.js 18+
- Expo CLI (`npm install -g expo-cli`)
- iOS Simulator (for macOS) or Android Emulator
- Physical device with Expo Go app (optional)

### Installation

1. Install dependencies:
```bash
npm install
```

2. Start the development server:
```bash
npm start
```

3. Run on iOS:
```bash
npm run ios
```

4. Run on Android:
```bash
npm run android
```

## Project Structure

```
mobile/
├── app/              # Expo Router screens (file-based routing)
│   ├── _layout.tsx   # Root layout
│   ├── index.tsx     # Initial screen (auth check)
│   ├── login.tsx     # Login screen
│   └── (tabs)/       # Tab navigation group
│       ├── _layout.tsx
│       ├── home.tsx
│       ├── games.tsx
│       ├── stats.tsx
│       └── profile.tsx
├── components/       # Reusable UI components
├── hooks/            # Custom React hooks
├── services/         # API clients, external services
│   └── api-client.ts
├── store/            # Zustand stores
│   └── auth-store.ts
├── types/            # TypeScript types
└── utils/            # Utility functions
```

## Environment Variables

Create an `app.config.js` or update `app.json` to include environment-specific configuration:

```javascript
export default {
  expo: {
    extra: {
      apiUrl: process.env.API_URL || 'http://localhost:3000',
    },
  },
};
```

## Development

- The app uses Expo Router for navigation
- Authentication state is managed with Zustand and persisted to AsyncStorage
- API calls use TanStack Query for caching and state management
- All API requests automatically include the auth token from the store

## License

Apache 2.0
