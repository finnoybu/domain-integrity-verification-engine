# DIVE — Domain Integrity Verification Engine

DIVE is a deterministic domain governance and infrastructure integrity monitoring system that snapshots, compares, and classifies operational drift over time.

## Core Capabilities

- Deterministic snapshot capture (RDAP, DNS, TLS)
- Bounded snapshot history
- Deterministic diff engine
- Rule-based classification (`stable`, `drift`, `risk`, `critical`)
- Time-based expiration evaluation
- Optional rule overrides
- Authentication boundary
- Optional rate limiting and normalized error responses

## Deterministic Philosophy

The system is designed for repeatable and auditable outcomes:

- Canonical snapshot shape is enforced before persistence
- UTC-based time computation is normalized for comparisons
- Classification is rule-driven, not probabilistic
- Diff output is deterministic for identical input states

## Non-Goals

DIVE is intentionally not:

- An attack surface scanner
- A vulnerability scanner
- A passive DNS aggregation platform
- A domain discovery tool
- An AI-based scoring engine

## Architecture Overview

```text
+---------------------+
|        User         |
+----------+----------+
           |
           v
+---------------------+
| Cloudflare DNS Proxy|
+----------+----------+
           |
           v
+---------------------+
| Caddy Reverse Proxy |
+----------+----------+
           |
           v
+---------------------------------------------------------+
|                    Node Application                     |
|                                                         |
|  +----------------+   +------------------------------+  |
|  | Snapshot Engine|-->| Diff Engine                  |  |
|  +----------------+   +---------------+--------------+  |
|                                      |                 |
|                                      v                 |
|                 +------------------------------+       |
|                 | Classification Engine        |       |
|                 +---------------+--------------+       |
|                                 |                      |
|                                 v                      |
|                 +------------------------------+       |
|                 | Expiration Evaluator         |       |
|                 +------------------------------+       |
+-----------------------------+---------------------------+
                              |
                              v
               +-------------------------------+
               | Filesystem Snapshot Store     |
               | data/snapshots/<domain>/*.json|
               +-------------------------------+
```

## API Surface Summary

Stable API surface under `0.1.x`:

- `GET /api/snapshot/latest`
- `GET /api/history`
- `GET /api/diff`
- `GET /api/status`

## Security Posture

### Authentication Boundary

- Bearer token enforcement on protected paths (`AUTH_ENABLED=true` by default)
- Deterministic `401` response shape via normalized API helper

### Rate Limiting

- Optional, environment-controlled in-memory sliding window
- Deterministic `429` responses with `Retry-After` header

### Error Normalization

- Structured error contracts for invalid input, upstream failure, and internal errors
- No stack traces returned in API responses

### Time and Comparison Integrity

- UTC timestamps are used for snapshot recording and expiration evaluation
- Diff and classification logic consume canonicalized snapshot fields

## Deployment Notes

Deployment guidance is maintained in [docs/deployment.md](docs/deployment.md).
This README intentionally avoids a full deployment walkthrough.

## Commercial Direction

This repository represents the reference implementation of the Domain Integrity Verification Engine.
Commercial deployment models and managed offerings may be developed in the future.

## Roadmap Summary (0.1.x)

- Core engine foundation is complete: snapshotting, history retention, diff, classification, and expiration evaluation
- Security boundary and normalized API behavior are in place
- Ongoing releases focus on governance hardening, deterministic behavior, and operational readiness

## Release Discipline

- Feature branch -> pull request -> squash merge to `main`
- Annotated version tags are created on `main` only
- Tag publication occurs after merge and verification gates

## Development

### Prerequisites

- Node.js 20+
- npm

### Commands

- `npm run dev`
- `npm run lint`
- `npm run build`
- `npm start`

## License

Licensing for this project is currently under evaluation.

© 2026 Finnoybu IP LLC. All rights reserved.
