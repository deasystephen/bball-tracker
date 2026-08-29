# AWS Deployment Guide

This guide covers setting up and deploying the Hooplings application on AWS.

## Prerequisites

- AWS account with appropriate permissions
- AWS CLI installed and configured
- Docker installed locally
- Terraform or AWS CDK (optional, for infrastructure as code)

## AWS Services Used

- **ECS (Fargate)**: Container orchestration for backend
- **RDS PostgreSQL**: Managed database
- **ElastiCache Redis**: Managed Redis cache
- **S3**: Object storage
- **CloudFront**: CDN for static assets
- **Application Load Balancer**: Load balancing
- **ECR**: Container registry
- **CloudWatch**: Logging and monitoring
- **Secrets Manager**: Secure credential storage
- **IAM**: Access management

## Initial Setup

### 1. Create ECR Repository

```bash
aws ecr create-repository --repository-name bball-tracker-backend --region us-east-1
```

### 2. Set Up RDS PostgreSQL

```bash
# Create RDS instance (use AWS Console or CLI)
aws rds create-db-instance \
  --db-instance-identifier bball-tracker-db \
  --db-instance-class db.t3.micro \
  --engine postgres \
  --master-username admin \
  --master-user-password <secure-password> \
  --allocated-storage 20 \
  --vpc-security-group-ids <security-group-id> \
  --db-subnet-group-name <subnet-group>
```

### 3. Create ElastiCache Redis

```bash
aws elasticache create-cache-cluster \
  --cache-cluster-id bball-tracker-redis \
  --cache-node-type cache.t3.micro \
  --engine redis \
  --num-cache-nodes 1
```

### 4. Create S3 Bucket

```bash
aws s3 mb s3://bball-tracker-storage --region us-east-1
```

### 5. Store Secrets in Secrets Manager

```bash
aws secretsmanager create-secret \
  --name bball-tracker/database \
  --secret-string '{"username":"admin","password":"<password>","host":"<rds-endpoint>"}'
```

## Building and Pushing Docker Image

```bash
# Login to ECR
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <account-id>.dkr.ecr.us-east-1.amazonaws.com

# Build image
docker build -t bball-tracker-backend -f docker/Dockerfile backend/

# Tag image
docker tag bball-tracker-backend:latest <account-id>.dkr.ecr.us-east-1.amazonaws.com/bball-tracker-backend:latest

# Push image
docker push <account-id>.dkr.ecr.us-east-1.amazonaws.com/bball-tracker-backend:latest
```

## ECS Task Definition

Create a task definition JSON file (`aws/ecs-task-definition.json`) with:

- Container image from ECR
- Environment variables
- Secrets from Secrets Manager
- Resource limits (CPU, memory)
- Logging configuration (CloudWatch)

## Deploying to ECS

```bash
# Register task definition
aws ecs register-task-definition --cli-input-json file://aws/ecs-task-definition.json

# Create or update service
aws ecs create-service \
  --cluster bball-tracker-cluster \
  --service-name bball-tracker-backend \
  --task-definition bball-tracker-backend \
  --desired-count 2 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-xxx],securityGroups=[sg-xxx],assignPublicIp=ENABLED}"
```

## Environment Variables

Set these in your ECS task definition or use Secrets Manager:

The source of truth is `infra/task-definition.json` (plain values) + `infra/ecs.tf` (Secrets Manager
references). As of 2026-08-23 the API task carries:

- `DATABASE_URL` (secret): PostgreSQL connection string; TLS to RDS uses `certs/rds-global-bundle.pem`
  (override with `RDS_CA_BUNDLE_PATH`)
- `REDIS_URL`: ElastiCache Redis endpoint (best-effort cache; the app fails open without it)
- `WORKOS_API_KEY`, `WORKOS_CLIENT_ID` (secrets), `WORKOS_REDIRECT_URI`; optional `WORKOS_JWT_ISSUER`
  (default `https://api.workos.com`) for local JWKS verification of access tokens
- `ADMIN_EMAILS` (comma-separated; legacy `ADMIN_EMAIL` still read): emails granted ADMIN at first sign-up
- `ALLOWED_REDIRECT_HOSTS` / `ALLOWED_REDIRECT_SCHEMES` (defaults `localhost` / `bball-tracker`): allowed
  `redirect_uri` targets for `GET /auth/login`
- `PUBLIC_APP_URL` (`https://capyhoops.com`): human-facing links in emails / invite pages
- `API_BASE_URL` (`https://api.capyhoops.com`): host for calendar feed / webcal URLs
- `DEFAULT_TIMEZONE` (`America/Los_Angeles`): time zone for dates in outbound email
- `AWS_REGION`, `S3_AVATARS_BUCKET`: avatar uploads via presigned S3 POST (bucket from `infra/s3.tf`)
- `AWS_SES_REGION`, `SES_FROM_ADDRESS` (`noreply@mail.capyhoops.com`): SES mailer
- `SENTRY_DSN` (secret), `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE` (injected by CI from the git SHA)
- `CORS_ORIGIN`, `PORT`, `NODE_ENV=production`
- `REDIS_SOCKET_ADAPTER_URL`: not set — Socket.io is single-replica; the server logs a `FATAL-WARN`
  at startup in production without it. Keep `desiredCount = 1` until a Redis adapter is wired up
  (issue #26)

Not used by the backend despite older docs: `JWT_SECRET` (WorkOS signs the JWTs), `S3_BUCKET`, and the
Kafka credentials (`backend/src/kafka/index.ts` is a config stub).

## Load Balancer Setup

1. Create Application Load Balancer
2. Configure target group pointing to ECS service
3. Set up health checks
4. Configure HTTPS listener with SSL certificate

## Monitoring

- Set up CloudWatch alarms for:
  - ECS service CPU/memory usage
  - RDS connection count
  - Application error rates
  - API response times

## Scaling

Configure auto-scaling for ECS service based on:
- CPU utilization
- Memory utilization
- Request count

## Cost Optimization

- Use appropriate instance sizes
- Enable RDS automated backups with retention
- Use S3 lifecycle policies
- Monitor and optimize CloudWatch log retention

## Security Best Practices

- Use IAM roles for ECS tasks (not access keys)
- Store secrets in Secrets Manager
- Use VPC for network isolation
- Enable encryption at rest for RDS and S3
- Use security groups to restrict access
- Enable CloudTrail for audit logging

