# Contributing to Hooplings

Thank you for your interest in contributing to Hooplings! This document provides guidelines and instructions for contributing to the project.

`CLAUDE.md` is the contributor contract for this repository; read it first. The rules there (conventional commits, squash merges via PR, per-package lint with zero warnings, docs updated in the same change) apply to every PR, whether a person or an agent opens it.

## Code of Conduct

This project adheres to a code of conduct that all contributors are expected to follow. Please be respectful and constructive in all interactions.

## How to Contribute

### Reporting Bugs

If you find a bug, please open an issue with:
- A clear, descriptive title
- Steps to reproduce the issue
- Expected vs. actual behavior
- Environment details (OS, Node version, etc.)
- Screenshots if applicable

### Suggesting Features

Feature suggestions are welcome! Please open an issue with:
- A clear description of the feature
- Use cases and benefits
- Any design considerations

### Dependency Updates

Dependency and security updates are automated. Dependabot opens weekly PRs; backend and web **patch and minor** bumps and mobile **patch** bumps auto-merge once CI passes (`.github/workflows/dependabot-auto-merge.yml`). Majors, mobile minors, GitHub Actions bumps and any mobile package with native code wait for a human (native code moves only with a new binary; the OTA drift guard blocks it in CI). The Daily Upgrade Scan (`.github/workflows/daily-upgrade-scan.yml`, 15:00 UTC) handles security `overrides` for vulnerable transitives and the deferral list. To add or remove a deferred package, edit the inline deferral list in `.github/prompts/daily-upgrade-scan.md`; the design and procedure are in [`docs/automation/daily-upgrade-scan.md`](docs/automation/daily-upgrade-scan.md).

### Pull Requests

1. **Create a branch from `main`** (`feature/…` or `fix/…`; the repository has a single long-lived branch and short-lived branches merge via squash PR)
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes** following our coding standards:
   - Follow TypeScript best practices
   - Write clear, self-documenting code
   - Add comments for complex logic
   - Update the matching `docs/` file in the same change

3. **Test your changes**. There is no root `package.json`; every command runs inside a package, and lint runs with `--max-warnings 0` everywhere (a warning fails CI):
   ```bash
   cd backend && npm run lint && npm run type-check && npm test
   cd mobile && npm run lint && npm run type-check && npm test
   cd web && npm run lint && npm run build
   ```
   Then test manually in the development environment (`docs/testing/conventions.md` describes what each suite must cover).

4. **Commit your changes**:
   - Use clear, descriptive commit messages
   - Follow the conventional commit format:
     - `feat: add new feature`
     - `fix: fix bug in X`
     - `docs: update documentation`
     - `refactor: refactor Y`
     - `test: add tests for Z`

5. **Push and create a Pull Request**:
   - Create a PR against `main` with a clear description
   - Reference related issues; use `Closes #n` only when the PR meets every acceptance criterion of that issue
   - Wait for review and address feedback; PRs are squash-merged

## Development Setup

See the [README.md](README.md) for setup instructions.

### Code Style

- **TypeScript**: Use strict mode, prefer explicit types
- **Linting**: ESLint is the only formatting and style authority (`npm run lint` in each package; never suppress a rule, fix the code)
- **Imports**: Use absolute imports where configured

### Project Structure

- `mobile/` - React Native/Expo mobile application
- `backend/` - Node.js/Express API server
- `web/` - Next.js web app (the public `hooplings.com/invite/<token>` accept flow)
- `infra/` - Terraform for the AWS infrastructure and the ECS task definition
- `docker/` - Dockerfile and entrypoint for the backend image
- `.maestro/` - Maestro end-to-end flows for the mobile app (manual only)
- `docs/` - Documentation (architecture, deployment, runbooks, testing)

### Testing

- Write tests for new features
- Maintain or improve test coverage
- Test both success and error cases

### Documentation

- Update README.md for user-facing changes
- Add/update API documentation for backend changes
- Include code comments for complex logic
- Update architecture docs for structural changes

## Development Workflow

1. Create a feature branch from `main`
2. Make changes with clear commits
3. Ensure tests pass and code is linted
4. Update documentation
5. Create pull request
6. Address review feedback
7. Squash-merge after approval, then delete the branch

## Questions?

Feel free to open an issue with the `question` label for any clarifications.

Thank you for contributing!
