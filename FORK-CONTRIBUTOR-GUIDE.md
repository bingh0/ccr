# Contributing the Windows sidecar via a fork — step by step

> For Linus. You have `git`, the `gh` CLI (run `gh auth status` to confirm you're
> logged in), and Claude Code. Copy-paste the commands in order; each block tells
> you what you should see. If anything looks different from "you should see",
> stop and ask before continuing.

---

## Why we do it this way (fork → branch → pull request)

On most open-source projects you **don't have write access** to the real
("upstream") repository — and even when you do, pushing your work straight onto a
shared branch surprises people (it's what just happened with `feature/windows-support`).

The standard model fixes that:

1. **Fork** — make your own server-side copy of the repo under your account. You
   own it and can push to it freely.
2. **Branch + commit** on your fork.
3. **Pull request** — propose your branch to the upstream repo. The maintainer
   reviews it and merges it.

This keeps the upstream repo clean, keeps the maintainer in control of what lands,
and still credits the work to you. It's how you contribute to any public repo you
don't control — learn it once and it's the same everywhere.

Two repos you'll refer to:

- **upstream** = `bingh0/ccr` — the real repo. You **never push** here.
- **origin** = `<you>/ccr` — your fork. You push here.

---

## Step 1 — Fork the repo and clone *your fork*

> **Got an existing clone into a tangle** (e.g. you tried to merge the upstream
> feature branch into yours and hit conflicts)? **Don't try to untangle it.** This
> step starts fresh in a *new* folder, and the reviewed work is safe on the server,
> so just abandon the messy clone and follow along here. Nothing of yours is lost —
> your original commit `51fac41` is intact on the server too.

Run this from a directory that does **not** already contain a `ccr` folder (so it
doesn't collide with any clone you already have):

```bash
cd ~ && mkdir -p code && cd code

# Fork bingh0/ccr to your account, clone YOUR fork, and wire up 'upstream':
gh repo fork bingh0/ccr --clone

cd ccr
git remote -v
```

You should see two remotes — your fork as `origin`, the real repo as `upstream`:

```
origin    https://github.com/<you>/ccr.git    (push)
upstream  https://github.com/bingh0/ccr.git   (push)
```

If `upstream` is missing (older `gh`), add it yourself:

```bash
git remote add upstream https://github.com/bingh0/ccr.git
```

Then fetch everything from the real repo so the reviewed work is available locally:

```bash
git fetch upstream
```

---

## Step 2 — See and prove the work is all there

The reviewed work lives at commit **`8e0c6f5`** on the feature branch. It is made
of two commits: **your** original work, plus Bing's review edits on top.

```bash
# The two commits that make up the reviewed work:
git log --oneline 7b85f5c..8e0c6f5
```

You should see:

```
8e0c6f5  Harden Windows launcher + add VS Code split-terminal sidecar   <- Bing's review edits
51fac41  Add native Windows support for the live sidecar                <- YOUR original work
```

```bash
# Your original work, file by file:
git show --stat 51fac41

# Exactly what Bing changed on top of yours (the review pass):
git diff --stat 51fac41 8e0c6f5
```

Nothing of yours was lost — `51fac41` is intact, and `8e0c6f5` is simply your
commit with the review edits stacked on top.

---

## Step 3 — Flatten it into one commit you fully author

You'll collapse `51fac41 + 8e0c6f5` into a **single commit authored by you**. No
need to keep Bing's separate commit — the goal is one clean commit that *is* the
final reviewed code.

```bash
# Start a new branch sitting exactly at the reviewed work:
git switch -c windows-support 8e0c6f5

# Collapse everything into ONE staged change set.
# 7b85f5c is the commit the feature originally branched from (its base);
# --soft keeps all the file changes staged while moving the branch pointer back.
git reset --soft 7b85f5c

# Commit it as a single commit — your name, your authorship:
git commit -m "Add native Windows + VS Code support for the live sidecar"
```

**Now prove the flatten kept everything.** This diff must print *nothing*:

```bash
git diff 8e0c6f5 HEAD
```

Empty output = your single commit is **byte-for-byte identical** to the reviewed
work — not one line added or dropped. Confirm it's one commit, authored by you:

```bash
git log --oneline -1
git show -s --format='author: %an <%ae>' HEAD
```

> If `git diff 8e0c6f5 HEAD` is **not** empty, stop — something went wrong with
> the base. Re-run from `git switch -c windows-support 8e0c6f5`, or ask Claude Code.

---

## Step 4 — Sanity-check it builds and passes

```bash
npm ci
npm test           # expect:  tests 227 / pass 227 / fail 0 / todo 0
npm run typecheck  # expect:  no errors (exits silently)
```

Both must be green before you ask for review.

---

## Step 5 — Run the reviews yourself (Claude Code)

Open Claude Code in this repo and run:

```
/code-review
/security-review
```

Read every finding. For each, decide **fix it**, **leave it (and know why)**, or
**note it as a follow-up**. Pay closest attention in the security review to the
Windows command-building (`src/launch-win.js` — `buildWtArgs` / `paneCommand`),
the `spawnSync` calls, and the OSC 52 clipboard write in `src/launch-vscode.js`.
Be ready to explain the deliberate choice already made there: paths that contain
`"` or `%` are **rejected** (not escaped), because those are the only characters
the `cmd /k` quoting can't make safe — and the trust boundary is the user's own
machine (self-injection, not remote code execution).

If you change anything, keep it one clean commit and re-check tests:

```bash
# after edits:
npm test && npm run typecheck
git add -A
git commit --amend --no-edit       # folds the fix into your single commit
```

---

## Step 6 — Push to your fork and open the PR

```bash
git push -u origin windows-support
```

Then open the pull request **to the real repo**. Easiest for a first PR — let `gh`
open the browser form (it fills in base = `bingh0/ccr:main`, head = your branch):

```bash
gh pr create --web
```

If that doesn't target the right repo, open the compare page directly (replace
`<you>` with your GitHub username):

```
https://github.com/bingh0/ccr/compare/main...<you>:ccr:windows-support?expand=1
```

Use this title and description:

**Title:**
```
Add native Windows + VS Code support for the live sidecar
```

**Description:**
```
Adds native-Windows launch for `ccr` (Windows Terminal split panes) and a second
launch path for VS Code's integrated terminal (split-pane sidecar, any OS). The
pure-Node core is reused unchanged — this is a launch-layer addition. Zero new
runtime dependencies, and no file under ~/.claude is ever modified.

## What's included
- Windows Terminal launcher (`src/launch-win.js`): `ccr` / `ccr <profile>` opens
  one window with Claude + `ccr sidecar` (~34%), CCR_STATE_DIR per pane, exit
  sentinel + temp-settings cleanup; graceful fallback when wt.exe is absent.
- VS Code split-terminal launcher (`src/launch-vscode.js`): detects
  TERM_PROGRAM=vscode, runs Claude in the current pane, prints a banner with the
  platform split key (Ctrl+Shift+5 / Cmd+\) and a shell-agnostic
  `ccr sidecar --state-dir "<dir>"` one-liner copied to the clipboard via OSC 52;
  `ccr sidecar --hint` reprints it. Default in VS Code on Windows; opt-in
  elsewhere via CCR_VSCODE=1.
- statusLine injected per-launch via a temp settings file (no ~/.claude mutation).

## Testing
- `npm test`: 227 pass / 0 fail / 0 todo. All Windows + VS Code .feature files are
  executable (wired step definitions), with unit tests underneath.
- `npm run typecheck`: clean.

## Security-relevant notes
- cmd.exe payload (`buildWtArgs`/`paneCommand`): paths are interpolated into a
  `cmd /k` line. We reject the two chars the quoting can't neutralize — `"` (ends
  the quote) and `%` (cmd expansion) — with a clear error instead of escaping.
  `& | < >` are literal inside the quotes and stay allowed. Trust boundary is the
  user's own env (self-injection, not RCE).
- Spawns use spawnSync with no `shell: true`. OSC 52 writes only the sidecar
  one-liner (no secrets). Profile names are allow-listed (^[A-Za-z0-9._-]+$).

## Out of scope (Phase 2+)
- Auto-triggering the VS Code split (needs an extension; `code` has no
  run-command verb).
- A graphical menu-bar / status-bar widget (separate package on `ccr economy
  --json`, never the zero-dep core).
```

---

## Step 7 — After you open it

- The maintainer (Bing) reviews. If he asks for changes, make them locally,
  `git commit` (or `--amend`), and `git push` — the PR updates automatically.
- If GitHub ever shows a merge conflict or "out of date", click **Update branch**
  (the merge is clean), or ask Claude Code: *"help me update my branch against
  upstream/main."*
- After it's merged, you can delete your `windows-support` branch. Your work is
  now in the real repo, credited to you. 🎸

---

### Quick reference

| Thing | Value |
|---|---|
| upstream (real repo, never push) | `bingh0/ccr` |
| origin (your fork, push here) | `<you>/ccr` |
| reviewed work (your commit + edits) | `8e0c6f5` |
| your original commit | `51fac41` |
| branch base (for the flatten) | `7b85f5c` |
| proof of completeness | `git diff 8e0c6f5 HEAD` → empty |
