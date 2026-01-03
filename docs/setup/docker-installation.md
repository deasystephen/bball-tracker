# Docker Installation Guide

## macOS Installation

### Option 1: Docker Desktop (Recommended)

Docker Desktop includes both Docker and Docker Compose in one package.

**Installation:**

1. **Using Homebrew (easiest):**
   ```bash
   brew install --cask docker
   ```

2. **Or download directly:**
   - Visit: https://www.docker.com/products/docker-desktop/
   - Download Docker Desktop for Mac
   - Install the `.dmg` file
   - Drag Docker to Applications folder

3. **Start Docker Desktop:**
   - Open Docker Desktop from Applications
   - Wait for it to start (whale icon in menu bar)
   - Docker Desktop must be running to use `docker` and `docker-compose` commands

**Verify installation:**
```bash
docker --version
docker-compose --version
```

### Option 2: Docker Compose Standalone (CLI only)

If you only need Docker Compose and don't want the full Docker Desktop:

```bash
brew install docker-compose
```

**Note:** This installs only Docker Compose. You'll still need Docker engine, which typically requires Docker Desktop on macOS.

## Verification

After installation, verify everything works:

```bash
# Check Docker version
docker --version

# Check Docker Compose version
docker-compose --version

# Test Docker is running
docker ps
```

If `docker ps` works without errors, Docker is running correctly.

## Starting Services

Once Docker is installed and running:

```bash
# From project root
docker-compose up -d

# Check services are running
docker-compose ps

# View logs
docker-compose logs

# Stop services
docker-compose down
```

## Troubleshooting

### Docker Desktop not starting
- Ensure you have enough disk space
- Check System Preferences > Security & Privacy for permissions
- Restart your Mac if needed

### Permission denied errors
- Make sure Docker Desktop is running
- You may need to add your user to the docker group (usually handled automatically)

### Port already in use
- If port 5432 (PostgreSQL) is in use, stop any local PostgreSQL instances
- If port 6379 (Redis) is in use, stop any local Redis instances
- Or modify ports in `docker-compose.yml`

## Resources

- [Docker Desktop for Mac](https://docs.docker.com/desktop/install/mac-install/)
- [Docker Compose Documentation](https://docs.docker.com/compose/)

