# Architecture Overview

## System Architecture

The Hooplings application is a single containerized API backed by PostgreSQL, with Socket.io broadcasting live game updates over WebSocket and Redis providing best-effort caching.

## High-Level Architecture

```
┌─────────────┐
│  iOS App    │
│ (Expo/RN)   │
└──────┬──────┘
       │ HTTP/WebSocket
       ▼
┌─────────────────────────────────┐
│   AWS Application Load Balancer  │
└──────┬──────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│   Backend API (ECS Fargate)     │
│   - Express/Node.js             │
│   - WebSocket Server            │
└──────┬──────────────────────────┘
       │
       ├──────────────┬──────────────┐
       ▼              ▼              ▼
┌──────────┐  ┌──────────┐  ┌──────────┐
│   RDS    │  │ElastiCache│  │   S3     │
│PostgreSQL│  │  Redis   │  │  Storage │
└──────────┘  └──────────┘  └──────────┘
```

## Components

### Mobile Application
- **Technology**: React Native with Expo
- **Navigation**: Expo Router
- **State Management**: Zustand (client) + TanStack Query (server)
- **Communication**: REST API + WebSocket for real-time updates

### Backend API
- **Technology**: Node.js with TypeScript
- **Framework**: Express
- **ORM**: Prisma
- **Real-time**: Socket.io for WebSocket connections
- **Deployment**: AWS ECS Fargate (containerized)

### Data Storage
- **PostgreSQL (AWS RDS)**: Primary relational database
  - User data, teams, leagues, games
  - Historical statistics
- **Redis (AWS ElastiCache)**: Best-effort caching (fails open)
  - Usage-metering counts (60s TTL, see `services/usage-service.ts`)

### File Storage
- **AWS S3**: Object storage for images, videos, documents
- **CloudFront CDN**: Content delivery for static assets

## Data Flow

### Game Event Flow
1. Coach tracks event in mobile app
2. App sends event to backend API via HTTP
3. Backend validates and stores it in PostgreSQL, deriving the game score
   from the event log inside the same transaction
4. Backend broadcasts the event and post-change score via Socket.io to
   clients in the game's room
5. Mobile apps receive the real-time update
6. When the game is marked FINISHED, `StatsService.finalizeGameStats`
   recomputes the box score from the event log and upserts per-player and
   per-team stats rows (re-run on any post-finish event edit)

### Real-time Updates
1. Backend maintains WebSocket connections with mobile apps
2. When game state changes, backend broadcasts to all connected clients
3. Mobile apps update UI in real-time

## Security

- **Authentication**: JWT tokens with refresh tokens
- **Authorization**: Role-based access control (Coach, Parent, Player, Admin)
- **API Security**: Rate limiting, input validation
- **AWS Security**: IAM roles, VPC isolation, security groups
- **Secrets Management**: AWS Secrets Manager

## Scalability

- **Horizontal Scaling**: ECS Fargate auto-scaling based on load
- **Database**: RDS read replicas for read-heavy operations
- **Caching**: Redis for frequently accessed data
- **CDN**: CloudFront for static asset delivery
- **Load Balancing**: Application Load Balancer distributes traffic

## Monitoring & Logging

- **AWS CloudWatch**: Application logs and metrics
- **Error Tracking**: Structured error logging
- **Performance Monitoring**: API response times, database query performance

## Deployment

- **Development**: Local Docker Compose
- **Staging**: AWS ECS with staging RDS instance
- **Production**: AWS ECS Fargate with multi-AZ RDS, ElastiCache cluster

