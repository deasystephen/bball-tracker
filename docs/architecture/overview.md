# Architecture Overview

## System Architecture

The Basketball Tracker application uses a microservices architecture with an event-driven design, leveraging Apache Kafka for event streaming and Apache Flink for real-time stream processing.

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
       │
       │ Events
       ▼
┌─────────────────────────────────┐
│   Confluent Cloud Kafka         │
│   - game-events                 │
│   - player-actions              │
│   - statistics-updates          │
└──────┬──────────────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│   Apache Flink                  │
│   - Stream Processing           │
│   - Statistics Aggregation      │
│   - Analytics                   │
└──────┬──────────────────────────┘
       │
       ▼
┌──────────┐  ┌──────────┐
│   RDS    │  │ElastiCache│
│PostgreSQL│  │  Redis   │
└──────────┘  └──────────┘
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

### Event Streaming
- **Kafka**: Confluent Cloud (managed service)
- **Topics**:
  - `game-events`: Raw play-by-play events
  - `player-actions`: Individual player actions
  - `statistics-updates`: Processed statistics from Flink
  - `game-state`: Current game state updates

### Stream Processing
- **Technology**: Apache Flink
- **Functions**:
  - Real-time statistics aggregation
  - Event enrichment
  - Analytics calculations
- **Output**: Writes aggregated data to PostgreSQL and Redis

### Data Storage
- **PostgreSQL (AWS RDS)**: Primary relational database
  - User data, teams, leagues, games
  - Historical statistics
- **Redis (AWS ElastiCache)**: Caching and real-time data
  - Session storage
  - Real-time game state
  - Cached statistics

### File Storage
- **AWS S3**: Object storage for images, videos, documents
- **CloudFront CDN**: Content delivery for static assets

## Data Flow

### Game Event Flow
1. Coach tracks event in mobile app
2. App sends event to backend API via HTTP
3. Backend validates and stores in PostgreSQL
4. Backend publishes event to Kafka `game-events` topic
5. Flink consumes event and processes it
6. Flink aggregates statistics and publishes to `statistics-updates` topic
7. Backend consumes statistics updates and stores in PostgreSQL/Redis
8. Backend broadcasts update via WebSocket to connected clients
9. Mobile apps receive real-time update

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

