# Project SOP

Standard operating procedure for working on the **AI QA Release Risk Agent**, for people and for Claude Code sessions. It exists so that work stays safe and consistent without relying on conversational memory.

- Read first: `CLAUDE.md` (entry point), `docs/PROJECT_DNA.md` (principles and protected areas), `docs/PROJECT_STATE.md` (latest verified status), `docs/DECISION_LOG.md` (history). `docs/AI_EVALUATION_PLAN.md` is authoritative for evaluation and live-readiness.
- **Update rule:** change this file only when the workflow changes. See section 5.
- Commands below assume Git Bash on Windows from the repository root. Adjust syntax for another shell. None of them needs the AI provider.

## 1. Procedures

### 1.1 Start a session and recover state
1. Establish the actual repository state; never rely on a summary:
   ```bash
   git rev-parse --show-toplevel
   git rev-parse --abbrev-ref HEAD
   git rev-parse HEAD
   git status --short
   git remote -v            # do not print a URL that contains credentials; mask it
   git rev-parse --abbrev-ref '@{u}'
   git log --oneline -10
   ```
2. Read `CLAUDE.md`, then `docs/PROJECT_STATE.md`. Compare its recorded branch, HEAD and status with step 1. **If they differ, the repository wins**: note the difference and continue read-only until it is understood (stop condition S1).
3. If the remote matters to the task, check it rather than trusting the document: `git ls-remote origin refs/heads/<branch>` (a read-only request to GitHub; the only network use routine inspection needs).
4. Note every uncommitted or untracked path. Those belong to the user. Do not stage, edit, reformat or delete them unless the task says so.
5. Do not read `.env`, print environment variable values, or test any credential.

### 1.2 Understand the objective and confirm scope
- State the goal, the acceptance criteria, the files expected to change and the files that must not change. Ask only about points that change correctness, safety, cost or scope; otherwise state a reversible assumption.
- Identify whether the task touches protected behaviour (`docs/PROJECT_DNA.md` section C) or could involve a provider request. If so, check section 2 (approval policy) before starting.

### 1.3 Inspect before changing
Read the relevant source, tests, documentation, `git diff` and `git log` for the files in question. Trace the real flow (for assessments: `web/` to `api/` to `src/pipelineCli.ts` to the gate to the report) instead of inferring it. Prefer running a small offline check to asking.

### 1.4 Plan and identify protected behaviour
For non-trivial, risky or architectural work, write a short plan first: files to change, the smallest design, what stays untouched, how it will be tested, what could be lost or break. Wait for approval when the change is large, touches protected paths, changes a response contract or may expose data. A backward-incompatible contract change always needs approval.

### 1.5 Implement the smallest justified change
No unrelated refactoring, formatting or dependency changes. Keep additive changes additive (for example a new optional response field). Keep presentation code free of decision logic. Do not weaken or delete an existing test to make a suite pass; if an assertion is wrong, say why and correct it narrowly.

### 1.6 Add focused regression tests
Tests are offline and deterministic: fake clients, injected analyzers, temporary directories outside the repository. Every new behaviour gets a test that fails without it. Changes near the gate need a test that decisions, rules and reasons are unchanged. Never call a provider from a test. Do not describe offline tests as evidence of live-provider behaviour.

### 1.7 Run checks
1. The focused test file(s): `node --test <file>`.
2. The standard check: `npm run check` (typecheck plus all unit tests; read the pass and fail counts from the output, do not quote an earlier number).
3. Evaluation checks when the evaluation or digest inputs, the pipeline or the provider code changed: the Stage 3B runner in offline dry-run mode with the output outside the repository,
   ```bash
   node tests/evaluation/runner.ts --out-dir "$TEMP/<some-scratch-dir>"
   ```
   Confirm four scenarios pass with the expected decisions and `providerRequestsAttempted` is 0 everywhere, read `baseline.sha256`, then delete the scratch directory. Never add `--live`.
4. For UI or API changes also run the Playwright suite if a matching browser is available. `npm run test:e2e` needs the Chromium build that the installed `@playwright/test` expects; if it is not installed, say the standard suite was not run. A scratch configuration that points at another installed Chrome is acceptable for a targeted run, but report it as such and never as the standard suite.
5. Report exact commands, counts and anything not run.

### 1.8 Inspect diffs and whitespace
`git diff` (and `git diff --cached` once staged), then `git diff --check` and `git diff --cached --check`. Working copies may be CRLF while the index is LF (`.gitattributes` sets `text=auto eol=lf`); the "CRLF will be replaced by LF" warnings are expected and are not to be "fixed" by rewriting files.

### 1.9 Review secrets and unrelated files
Scan added lines for key-shaped strings (`AIza...`, `ya29.`, `sk-...`, private-key headers, tokens), `.env`-like file names, large or binary files, and any path outside the task. Fake test values must be obviously fake. Confirm the unrelated user files from step 1.1 are untouched.

### 1.10 Stage explicit paths only
When any unrelated change exists, never use `git add -A`, `git add .` or `git commit -a`. Stage named paths, then prove the index:
```bash
git add -- <path1> <path2> ...
git diff --cached --name-only | sort | diff - <(printf '%s\n' <path1> <path2> ... | sort) && echo "staged set is exactly the approved paths"
git diff --cached --check
```
Also confirm the protected paths are not in the index unless the task approved them.

### 1.11 Commit with a scoped message
One coherent change per commit. Subject in the style the history uses (`feat:`, `fix:`, `test:`, `docs:` or a plain imperative). The body states the scope, the safety-relevant limits, what was tested and what was **not** tested (for example "live provider behaviour was not tested"). Do not include secrets, prompts or confidential evidence. Afterwards verify `git show --name-status HEAD` lists only the intended files and `git status --short` shows only the preserved user files.

### 1.12 Before pushing
```bash
git fetch origin
git rev-list --left-right --count origin/<branch>...HEAD
git merge-base --is-ancestor origin/<branch> HEAD && echo fast-forward
git log --oneline origin/<branch>..HEAD
git remote -v            # mask credentials
```
Confirm the branch, the upstream, that the push is a fast-forward, and exactly which commits it includes. A push publishes every unpushed ancestor, so review the whole range, not only the latest commit, and scan it for secrets, binaries and unrelated paths. Run `npm run check` again. Never force-push.

### 1.13 Push and verify the remote
`git push origin <branch>`. A success message is not proof. Verify with `git ls-remote origin refs/heads/<branch>` and a fresh `git fetch`, and confirm the remote tip equals local `HEAD` and contains the expected commits. Only then record the push as done.

### 1.14 Close the task
End every substantial task with: what changed (exact files), what was verified and how, what was **not** verified or not run, blockers and approvals still needed, the final `git status --short`, and the single recommended next action. Then update the documents per section 5.

## 2. Approval policy

| Action | Needs explicit approval? |
| --- | --- |
| Read-only inspection (reading code, docs, `git status`, `git log`, `git diff`, running offline tests) | No |
| Changing application behaviour | Only within the approved task scope; anything beyond it needs approval |
| Changing gate logic, thresholds, validation, the findings adapter, policy, evaluation scenarios or their expected values, or safety controls (routing guard, sanitising, runner controls) | Yes, when outside the approved scope. Inside the scope it still needs regression tests and a decision-log entry |
| Changing a response contract in a backward-incompatible way | Yes |
| Live AI evaluation or any provider request | Yes, specifically; never inferred from general implementation approval |
| Reading `.env`, handling or testing credentials, changing provider configuration | Yes, specifically |
| Deployment, including anything that may trigger an automatic deployment | Yes, specifically |
| Destructive Git operations (`reset --hard`, `clean`, `checkout --`, `restore`, `stash drop`, branch deletion, history rewriting) | Yes, specifically |
| Force-push; changing repository, branch-protection or hosting settings | Yes, specifically, and rarely |
| Adding or upgrading dependencies, or changing package scripts | Yes |
| Staging and committing | Only when the request says to commit. A request to prepare, review or propose is not a request to commit |
| Pushing | Only when the request says to push. **A request to commit does not authorise a push.** |
| Deploying | **A request to push does not authorise deployment.** |

Approval is per action and per task. An approval in one session does not carry to the next.

## 3. Stop conditions

Stop, report the evidence and wait for instructions when any of these occurs:

- **S1 Unexpected repository state:** the branch, HEAD, remote or upstream differs from what the task or `PROJECT_STATE.md` says.
- **S2 Remote divergence:** the remote has commits the local branch lacks, or a push would not be a fast-forward, or the upstream is unclear.
- **S3 Failed tests:** `npm run check` or a relevant test fails. Report the output; do not commit or push on a red check.
- **S4 Unexplained digest or fingerprint change:** the Stage 3B baseline digest or scenario fingerprint differs from what the documents record and no task explains it. Do not update the recorded value to match.
- **S5 Accidental changes:** a file outside the task scope was modified, staged or deleted.
- **S6 Possible provider request:** any doubt that a command may have contacted an AI provider, or a secret may have been printed, committed or logged.
- **S7 Protected behaviour:** the safe way to finish needs a change to a protected path or contract that was not approved.
- **S8 Contradiction:** two project documents, or a document and the code, conflict in a way that changes what to do. Name the conflict and the authoritative source; do not invent a reconciliation.

## 4. Operational notes (lessons recorded from past work)

These are practical notes, not decisions.
- A throwaway copy of the repository (for example to prove a baseline can be reproduced) must live outside the repository. If it contains a link or junction to `node_modules`, remove the link itself before deleting the directory, and confirm `node_modules` is intact afterwards.
- A heredoc that contains unusual quoting can fail in the shell; write the file with the editor tool instead of guessing.

## 5. Keeping the documents current (maintenance rule)

These documents are **not** automatically synchronised. They stay accurate only because each task follows these rules and verifies against the repository.

| Document | Update when |
| --- | --- |
| `docs/PROJECT_STATE.md` | After substantive work, commits, pushes, test runs, or a change in blockers or approvals |
| `docs/PROJECT_DNA.md` | Only when an enduring principle or architecture constraint changes through an approved decision (also add a decision-log entry) |
| `docs/PROJECT_SOP.md` | Only when the workflow changes |
| `docs/DECISION_LOG.md` | Append an entry whenever a material decision is made, proposed, rejected or superseded. Do not edit past entries except to mark them superseded |
| `docs/AI_EVALUATION_PLAN.md` | When evaluation requirements, readiness items or baseline records change. It is authoritative for evaluation; keep historical records and add dated new ones |

If two documents conflict, identify the conflict, follow the authoritative source (code, tests, Git and remote checks for facts; the evaluation plan for evaluation; the DNA for principles), and report it. Never silently reconcile them. When a status line in `docs/PROJECT_STATE.md` cannot be re-verified, mark it `NOT VERIFIED` instead of leaving it looking current.
