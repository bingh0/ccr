# Release runbook — `feature/windows-support` (junior-dev exercise)

> Scratch / personal — **do not commit** this file or `pr-body.md`; they aren't
> part of the release. Goal: take this branch through the whole release process —
> PR → code review → security review → address findings → approval → merge.

## Where things stand
- `feature/windows-support` is on origin, two commits ahead of `main`:
  - `51fac41` — your initial Windows support.
  - `8e0c6f5` — review pass (made the Gherkin executable, restored `updateFeed`
    test coverage, hardened the `cmd.exe` quoting, removed the dead `.cmd` shim)
    **+** the VS Code split-terminal launcher.
- Green: `npm test` → 227 pass / 0 fail / 0 todo; `npm run typecheck` → clean.
- `main` has a CODEOWNERS rule requiring **@bingh0** review — so you open the PR
  and run the reviews; Bing approves + merges.

## 0. Sync + sanity-check locally
```bash
git fetch origin
git checkout feature/windows-support
git pull --ff-only            # should already match origin (8e0c6f5)
npm ci
npm test && npm run typecheck  # both must be green before review
```

## 1. Open the PR
GitHub UI, or:
```bash
gh pr create --base main --head feature/windows-support \
  --title "Windows support for the live sidecar (Windows Terminal + VS Code)" \
  --body-file pr-body.md
```
`pr-body.md` (next to this file) is a draft — read it and make it yours. Note the
PR number it prints.

## 2. Code review
In a Claude Code session on this branch:
- `/code-review` — reviews the branch diff vs `main`. Start here.
- Deeper multi-agent cloud pass (billed — ask Bing first): `/code-review ultra <PR#>`.

Read every finding. For each, decide: **fix**, **won't-fix (with a reason)**, or
**follow-up issue**. Don't blindly apply — understand why first.

## 3. Security review
- `/security-review` on the branch.
- **Look hardest at**: `src/launch-win.js` `buildWtArgs` / `paneCommand` (the
  `cmd /k` payload), the `spawnSync` calls, and the OSC 52 clipboard write in
  `src/launch-vscode.js`.
- Know the deliberate call already made: we **reject** `"` and `%` in interpolated
  paths rather than escape them (see `pr-body.md`). If the tool flags the
  interpolation, that's the discussion to have — is reject-vs-escape the right
  trade for a self-injection (not RCE) trust boundary?

## 4. Address findings
```bash
# make changes
npm test && npm run typecheck          # stay green
git commit -am "review: <what you changed and why>"
git push --no-verify origin feature/windows-support
```
**Why `--no-verify`**: the repo's `pre-push` hook only allows pushing `main` (a
guard against accidental publishes). Pushing this feature branch is a deliberate,
known exception. The PR updates automatically on push.

## 5. Request review + merge
- Request review from **@bingh0** (CODEOWNERS requires it).
- After approval, merge via the GitHub UI. (The FF-only pre-push hook only gates
  *local* pushes to `main`; a server-side PR merge isn't affected.)
- Delete the branch when done.

## Be ready to explain (Bing may ask)
- Why the 6 Windows `.feature` files now have step defs in `test/steps/`
  (BDD-first: the Gherkin is the source of truth — it must *execute*, not just
  document; before, 29 scenarios were `todo` and tested nothing).
- Why the `.cmd` statusline shim was removed (the launcher never invoked it).
- Why VS Code can't auto-split the terminal (the `code` CLI exposes no
  run-command verb; automating it would need an extension).
