# Contributing to Basketball Tracker

Thank you for your interest in contributing to Basketball Tracker! This document provides guidelines and instructions for contributing to the project.

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

### Pull Requests

1. **Fork the repository** and create a branch from `main`
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes** following our coding standards:
   - Follow TypeScript best practices
   - Write clear, self-documenting code
   - Add comments for complex logic
   - Update documentation as needed

3. **Test your changes**:
   - Run the test suite: `npm test`
   - Test manually in development environment
   - Ensure no linting errors: `npm run lint`

4. **Commit your changes**:
   - Use clear, descriptive commit messages
   - Follow conventional commit format when possible:
     - `feat: add new feature`
     - `fix: fix bug in X`
     - `docs: update documentation`
     - `refactor: refactor Y`
     - `test: add tests for Z`

5. **Push and create a Pull Request**:
   - Push to your fork
   - Create a PR with a clear description
   - Reference any related issues
   - Wait for review and address feedback

## Development Setup

See the [README.md](README.md) for setup instructions.

### Code Style

- **TypeScript**: Use strict mode, prefer explicit types
- **Formatting**: Use Prettier (configured in project)
- **Linting**: Follow ESLint rules
- **Imports**: Use absolute imports where configured

### Project Structure

- `mobile/` - React Native/Expo mobile application
- `backend/` - Node.js API server
- `streaming/` - Kafka and Flink configurations
- `shared/` - Shared types and utilities
- `docs/` - Documentation

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
7. Merge after approval

## Questions?

Feel free to open an issue with the `question` label for any clarifications.

Thank you for contributing!

