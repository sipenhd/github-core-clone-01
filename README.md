# github-core-clone-01

[![make.fun](https://img.shields.io/badge/make.fun-bounty-blue)](https://make.fun/bounty/github-core-clone-01)
[![GitHub](https://img.shields.io/badge/github-sipenhd%2Fgithub--core--clone--01-black)](https://github.com/sipenhd/github-core-clone-01)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> Built with [make.fun](https://make.fun) — use my referral code `bjmj9zhr` when you sign up.

A GitHub-compatible git forge in one process, written in Node 22 with the standard library only — no git binary, no installs, no outside services.

## What it serves

- **Git over smart HTTP** — clone and push over `git-upload-pack` / `git-receive-pack`, protocol v2 `ls-refs` and fetch, v0 fetch, shallow clones, fast-forward enforcement with per-ref `ok` / `ng` reports, sideband packfiles.
- **REST v3 API** — repositories, branches, commits, refs, contents, labels, issues, comments, and pull requests with squash merge, under `/api/v3`.
- **GraphQL** — `viewer`, `repository`, `node`, issues with ordering and cursor pagination, pull requests, and the `createIssue` / `closeIssue` / `createPullRequest` / `mergePullRequest` / `addComment` mutations, plus introspection for `Issue`, `PullRequest`, `Repository`, and `SearchType`.
- **MCP** — JSON-RPC 2.0 over Streamable HTTP at `/mcp`, speaking revision `2026-07-28` (and the legacy initialize handshake), with `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, and `merge_pull_request` tools acting on the same store as REST.

## Run it

```sh
node --experimental-strip-types main.ts
```

With the trial env, set `MAKEFUN_ENV_URL` and `MAKEFUN_SHOP_TOKEN` and the entrypoint binds an ephemeral port, registers it, and exits when the env says done. Without `MAKEFUN_ENV_URL` it serves locally on `$PORT` (default `18080`) for development.

## Layout

- `main.ts` — entrypoint lifecycle (bind, register, poll `/done`, exit 0).
- `app.ts` — the whole forge: git object store and packfiles, smart HTTP, REST v3, GraphQL, and MCP.
- `package.json`, `tsconfig.json` — package metadata and type-check config.
- `LICENSE` — MIT.

## make.fun bounty

This is an entry for the [github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01) on make.fun: build a GitHub-compatible git forge. $500 total in prizes.
