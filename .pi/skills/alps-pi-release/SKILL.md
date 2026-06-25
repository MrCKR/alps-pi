---
name: alps-pi-release
description: Release workflow for this alps-pi package. Use whenever the user asks to publish alps-pi, release to npm, create a git tag, prepare GitHub Release notes, bump version, or check whether the project is ready for npm/GitHub release.
compatibility: Requires git, npm, PowerShell on Windows, npm registry access via NPM_TOKEN, and optional GitHub release tooling/token.
---

# Alps Pi Release

Use this skill for releasing this repository to npm and GitHub. The workflow is intentionally conservative: verify first, then bump, test, publish, push, and only create GitHub Release when credentials/tooling are available.

## Scope

This skill applies to the `alps-pi` project. It covers:

- npm package release.
- `package.json` and `package-lock.json` version bump.
- git release commit and annotated tag.
- push to `origin`.
- optional GitHub Release object.
- release notes generation.

Do not use this skill for unrelated packages without adapting package names, repository URL, and test commands.

## Safety Rules

- Never print or write `NPM_TOKEN`, `npm_token`, `GITHUB_TOKEN`, or `GH_TOKEN`.
- Never store tokens in `.npmrc`, repo files, shell history, or release notes.
- Use a temporary npm config file for `npm publish`, then delete it.
- Do not publish if `npm view alps-pi version` already equals the target version.
- Do not create a tag that already exists locally or remotely.
- Do not publish with a dirty worktree unless the dirty files are exactly the version bump that will be committed.
- Prefer patch release for bugfix/performance/UI polish unless the user explicitly requests minor/major.
- If GitHub Release tooling is unavailable, still push the git tag and give the user ready-to-paste release notes.

## Preflight

Run these checks before changing files:

```powershell
git status -sb
git log -3 --oneline
git tag --list --sort=-version:refname | Select-Object -First 10
node -p "const p=require('./package.json'); JSON.stringify({name:p.name, version:p.version, files:p.files, pi:p.pi}, null, 2)"
npm view alps-pi version --json
if ($env:NPM_TOKEN) { 'NPM_TOKEN=present' } elseif ($env:npm_token) { 'npm_token=present' } else { 'NPM_TOKEN=missing' }
if ($env:GITHUB_TOKEN) { 'GITHUB_TOKEN=present' } elseif ($env:GH_TOKEN) { 'GH_TOKEN=present' } else { 'GITHUB_TOKEN=missing' }
if (Get-Command gh -ErrorAction SilentlyContinue) { 'gh=present' } else { 'gh=missing' }
```

Interpretation:

- Worktree should be clean before version bump.
- Local branch should be `main` and synchronized with `origin/main`, unless the user explicitly asks otherwise.
- npm online version must be lower than the target version.
- npm token must be present before `npm publish`.
- GitHub token or `gh` is only required for creating the GitHub Release object, not for pushing git tags when normal git auth works.

## Choose Version

Default decision:

- patch: bugfixes, reload hardening, performance fixes, small UI polish.
- minor: new user-facing feature or setting.
- major: breaking install/config/runtime behavior.

For this project, typical patch bump:

```powershell
npm version 0.1.X --no-git-tag-version
```

This updates `package.json` and `package-lock.json` together.

## Validate Before Commit

After bumping the version:

```powershell
npm test
npm pack --dry-run
git diff -- package.json package-lock.json
```

Expected:

- `npm test` passes completely.
- `npm pack --dry-run` shows the intended package version and includes `index.ts`, `src`, `themes`, `README.md`, `LICENSE`, and `package.json`.
- Version diff only changes the version fields.
- `npm pack --dry-run` should not leave a `.tgz` file; check and remove if needed.

```powershell
Get-ChildItem -Name *.tgz 2>$null
```

## Commit And Tag

Use a release commit and annotated tag:

```powershell
git add package.json package-lock.json
git commit -m "release: v0.1.X"
git tag -a v0.1.X -m "v0.1.X"
git status -sb
git log -3 --oneline
git tag --list --sort=-version:refname | Select-Object -First 5
```

If tag creation fails because it exists, stop and inspect. Do not overwrite tags unless the user explicitly asks and understands the risk.

## Publish To npm

Use the environment token with a temporary `.npmrc` outside the repo:

```powershell
$token = if ($env:NPM_TOKEN) { $env:NPM_TOKEN } else { $env:npm_token }
if (-not $token) { throw 'NPM_TOKEN is missing' }
$tmpNpmrc = Join-Path $env:TEMP ('alps-pi-npmrc-' + [guid]::NewGuid().ToString() + '.npmrc')
try {
  "//registry.npmjs.org/:_authToken=$token" | Set-Content -Path $tmpNpmrc -NoNewline -Encoding utf8
  npm publish --userconfig $tmpNpmrc --access public
} finally {
  Remove-Item $tmpNpmrc -Force -ErrorAction SilentlyContinue
}
```

After publish:

```powershell
npm view alps-pi version --json
npm view alps-pi@0.1.X dist-tags version dist.tarball --json
```

Expected:

- `latest` points to the new version.
- `dist.tarball` resolves to `https://registry.npmjs.org/alps-pi/-/alps-pi-0.1.X.tgz`.

## Push Git

Push release commit and tag after npm publish succeeds:

```powershell
git push origin main
git push origin v0.1.X
git status -sb
git rev-list --left-right --count origin/main...HEAD
```

Expected:

- `main` is synchronized with `origin/main`.
- left/right count is `0 0`.

If npm publish succeeds but git push fails, tell the user immediately: npm has already been released and git needs retrying.

## GitHub Release

First check whether the Release object exists:

```powershell
# If no auth is available, this can still return 404 for missing release.
# Use web/API fetch or browser if available.
```

If `gh` is available and authenticated:

```powershell
gh release create v0.1.X --title "v0.1.X" --notes-file RELEASE_NOTES.tmp.md
Remove-Item RELEASE_NOTES.tmp.md -Force
```

If `gh` or GitHub token is not available:

- Do not claim GitHub Release was created.
- State that the git tag was pushed.
- Provide ready-to-paste release notes.
- Tell the user to create a GitHub Release from tag `v0.1.X` in the web UI.

## Release Notes Template

Use this compact format:

```markdown
## v0.1.X

### Fixes
- Fixed <specific bug>.
- Hardened <runtime/lifecycle path>.

### Improvements
- Improved <user-visible behavior>.
- Added <diagnostic/display/performance improvement>.

### Validation
- `npm test` passed: <N>/<N>.
```

For the `0.1.2` release, the notes were:

```markdown
## v0.1.2

### Fixes
- Fixed fixed-bottom input being released by stale/no-UI subagent contexts.
- Hardened Animations runtime against stale extension ctx after reload/session replacement.
- Prevented Animations frame ticks from forcing full TUI/history renders; animation repaint now uses bottom-local repaint when available.

### Improvements
- Added chrome-frame token estimate display beside the frame title, based on raw message/tool/bash context data.
- Added bottom-input diagnostic logging support via sentinel file.

### Validation
- `npm test` passed: 356/356.
```

## Final Report

End with:

- npm version published.
- git commit and tag pushed.
- GitHub Release status.
- validation command and result.
- upgrade command for users.

Example:

```text
已发布 alps-pi@0.1.X。
- npm latest: 0.1.X
- git: main pushed, tag v0.1.X pushed
- GitHub Release: created / not created because ...
- 验证: npm test passed, N/N
- 安装: pi install npm:alps-pi@0.1.X，然后 /reload
```
