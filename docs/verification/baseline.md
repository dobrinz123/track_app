# Baseline — Repository State at Project Start

Date: 2026-08-06
Recorded by: Fable 5 (foreman/orchestrator)

## State

`D:\CODE\APLICTIE_Circuit` was an **empty directory** at project start (containing only a `.claude/` local settings folder). There was:

- no git history (git initialized on 2026-08-06 with default branch `main`)
- no existing framework, manifests, or lockfiles
- no source code, tests, CI workflows, or design system
- no pre-existing failures (nothing to run)

## Consequence

There is no existing framework to preserve. The stack is chosen fresh; see
`docs/decisions/ADR-0001-stack.md`. All subsequent verification compares
against this empty baseline: every file in the repository was produced by
this project's orchestrated build.

## Toolchain observed on the build machine

- Windows 11 Home 10.0.26200
- Node.js v24.18.0, npm 11.16.0
- git available; Codex CLI 0.145.0 (ChatGPT-subscription login)
- No Flutter SDK, no Android SDK / Xcode assumed present (native platform
  builds are documented as out-of-machine steps; see known limitations)
