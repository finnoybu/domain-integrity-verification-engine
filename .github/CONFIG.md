# GitHub Configuration

This directory contains GitHub-specific configuration files for the Finnoybu Domain Snapshot Tool.

## Contents

### Workflows (`workflows/`)

Automated CI/CD pipelines using GitHub Actions:

#### `pr-build.yml` - Pull Request Test Build
- **Trigger:** Pull request opened or updated to `main`
- **Purpose:** Validate code changes before merge
- **Actions:**
  - Checkout code
  - Install dependencies
  - Run ESLint
  - Execute test build
  - Verify build artifacts
- **Requirements:** Must pass before PR can be merged

#### `production-build.yml` - Production Build
- **Trigger:** Push to `main` branch (after PR merge)
- **Purpose:** Create production-ready build artifacts
- **Actions:**
  - Checkout code with full history
  - Install dependencies
  - Run ESLint
  - Execute production build
  - Extract version from Git tags
  - Upload build artifacts (30-day retention)
  - Generate build summary
- **Artifacts:** Stored for deployment or rollback

### Documentation

#### `WORKFLOW.md` - Git Workflow Guide
Complete documentation for:
- Instruction set detection (`v#.#.#-description.md` pattern)
- Branch management and naming conventions
- CI/CD pipeline details
- Step-by-step process for feature development
- PR creation and merge workflow

#### `copilot-instructions.md` - Project Master Prompt
AI assistant context and project specifications:
- Project purpose and goals
- Technology stack
- Data model (DomainSnapshot interface)
- Completion status and version history
- Implementation details

## CI/CD Pipeline Flow

```
┌─────────────────────────────────────────────────────────┐
│ Developer creates feature branch                        │
│ git checkout -b feature/vX.X.X-feature-name             │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│ Implement changes, commit, and push to GitHub           │
│ git push origin feature/vX.X.X-feature-name             │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│ Create Pull Request on GitHub                           │
│ PR triggers: pr-build.yml                               │
├─────────────────────────────────────────────────────────┤
│ ✓ Install dependencies (npm ci)                         │
│ ✓ Run ESLint (npm run lint)                             │
│ ✓ Run test build (npm run build)                        │
│ ✓ Verify build artifacts                                │
└────────────────┬────────────────────────────────────────┘
                 │
                 ├──✅ PASS → Ready to merge
                 │
                 └──❌ FAIL → Fix issues and push again
                 │
                 ▼ (after CI passes)
┌─────────────────────────────────────────────────────────┐
│ Merge Pull Request to main                              │
│ Merge triggers: production-build.yml                    │
├─────────────────────────────────────────────────────────┤
│ ✓ Install dependencies                                  │
│ ✓ Run ESLint                                             │
│ ✓ Run production build                                  │
│ ✓ Extract version tag                                   │
│ ✓ Upload artifacts (30-day retention)                   │
│ ✓ Generate build summary                                │
└────────────────┬────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────┐
│ Tag release and cleanup                                 │
│ git tag -a vX.X.X -m "Description"                      │
│ git push origin --tags                                  │
│ Delete feature branch                                   │
└─────────────────────────────────────────────────────────┘
```

## Node.js Version

All workflows use **Node.js 20.x** to match project requirements.

## Artifact Retention

Build artifacts are retained for **30 days** and include:
- `.next/` directory (Next.js build output)
- `public/` directory (static assets)
- `package.json` and `package-lock.json` (dependency manifests)

## Local Testing

Before pushing, always test locally:

```bash
# Run linter
npm run lint

# Run build
npm run build

# Verify no errors in terminal output
```

This ensures faster CI feedback and reduces failed builds.

---

**Note:** GitHub Actions workflows require repository secrets to be configured if deploying to external services. Current configuration runs builds only without deployment.
