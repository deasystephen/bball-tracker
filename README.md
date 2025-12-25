# Basketball Tracker

An open-source basketball tracking application for youth basketball teams, featuring real-time game tracking, statistics, and analytics. Built with React Native/Expo for iOS, Node.js backend, and event-driven architecture using Kafka and Flink.

## Features

- **Real-time Game Tracking**: Track games with play-by-play events
- **Multi-role Support**: Coaches, Parents, Players, and Admins with role-based access
- **League Management**: Manage multiple teams, leagues, and seasons
- **Statistics & Analytics**: Real-time statistics aggregation and historical analytics
- **Event Streaming**: Powered by Confluent Cloud Kafka and Apache Flink
- **Mobile-First**: Native iOS app built with React Native and Expo

## Tech Stack

### Frontend/Mobile
- React Native with Expo
- Expo Router for navigation
- TanStack Query for server state
- Zustand for client state

### Backend
- Node.js with TypeScript
- Express web framework
- Prisma ORM
- WebSocket (Socket.io) for real-time updates

### Infrastructure
- AWS ECS (Fargate) for backend deployment
- AWS RDS PostgreSQL for database
- AWS ElastiCache Redis for caching
- AWS S3 for file storage
- Confluent Cloud Kafka for event streaming
- Apache Flink for stream processing

## Getting Started

### Prerequisites

- Node.js 18+ and npm/yarn
- Docker and Docker Compose
- Expo CLI
- AWS CLI (for deployment)
- Confluent Cloud account (for Kafka)

### Local Development Setup

1. Clone the repository:
```bash
git clone https://github.com/yourusername/bball-tracker.git
cd bball-tracker
```

2. Set up environment variables:
```bash
cp backend/.env.example backend/.env
# Edit backend/.env with your configuration
```

3. Start local services with Docker Compose:
```bash
docker-compose up -d
```

4. Set up the database:
```bash
cd backend
npm install
npx prisma migrate dev
npx prisma generate
```

5. Start the backend server:
```bash
npm run dev
```

6. Start the mobile app:
```bash
cd mobile
npm install
npx expo start
```

## Project Structure

```
bball-tracker/
├── mobile/          # React Native/Expo mobile app
├── backend/         # Node.js API server
├── streaming/       # Kafka/Flink configurations
├── shared/          # Shared types and utilities
├── docs/            # Documentation
└── aws/             # AWS infrastructure as code
```

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

## Documentation

- [Architecture Overview](docs/architecture/overview.md)
- [API Documentation](docs/api/)
- [Deployment Guide](docs/deployment/aws-setup.md)
- [Contributing Guidelines](CONTRIBUTING.md)

## Support

For questions, issues, or feature requests, please open an issue on GitHub.

