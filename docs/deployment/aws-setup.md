# AWS Deployment Guide

This guide covers setting up and deploying the Basketball Tracker application on AWS.

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

- `DATABASE_URL`: PostgreSQL connection string
- `REDIS_URL`: ElastiCache Redis endpoint
- `KAFKA_BROKERS`: Confluent Cloud Kafka brokers
- `KAFKA_API_KEY`: Confluent Cloud API key
- `KAFKA_API_SECRET`: Confluent Cloud API secret
- `JWT_SECRET`: JWT signing secret
- `S3_BUCKET`: S3 bucket name
- `AWS_REGION`: AWS region

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

