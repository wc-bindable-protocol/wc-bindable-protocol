---
name: release
description: Cut a lockstep release of all @wc-bindable/* workspaces — bump versions, update RELEASE_NOTES, build, tag, and publish to npm. Trigger when the user asks to release, publish, bump version, or cut a new version.
---

# Release skill

This monorepo uses **lockstep versioning**: every `packages/*` shares one version, and every inter-workspace dependency (`@wc-bindable/<x>` depending on `@wc-bindable/core`) is pinned to that same version on each release.

The skill is a checklist. Walk it top-to-bottom. Confirm with the user before any irreversible step (publish, push tag).

## Pre-flight

1. Working tree clean — `git status`. If dirty, stop and ask the user.
2. Branch — `git branch --show-current`. Releases normally cut from `main`. If not on main, confirm.
3. Target version — if the user didn't say one, read the top of [RELEASE_NOTES.md](../../RELEASE_NOTES.md) for the previous version and ask which bump (patch / minor / major). Establish `<NEW>` (e.g. `0.5.0`) and `<PREV>` (e.g. `0.4.0`).
4. Sanity — `git fetch && git status` to confirm no behind-remote drift.

## 1. Bump versions in lockstep

For each `packages/*/package.json`:

- `version` → `<NEW>`
- Every `dependencies` / `peerDependencies` / `devDependencies` entry whose key starts with `@wc-bindable/` → `^<NEW>`

Verify after editing:

```
git grep -nE '"version"|"@wc-bindable/' -- packages/*/package.json
```

Every occurrence should be either `<NEW>` or `^<NEW>`. No stragglers from `<PREV>`.

## 2. Refresh the lockfile

```
npm install
```

Inspect the resulting `package-lock.json` diff for surprises:
- Expected: workspace versions update; inter-workspace `dependencies` resolve to the new versions.
- Unexpected: `extraneous` workspace entries, dropped/added third-party packages. Investigate before continuing — do **not** delete `node_modules/` or `package-lock.json` reflexively.

## 3. Update RELEASE_NOTES.md

Prepend a new `# v<NEW>` section above the previous one. Use the existing v0.4.0 entry as the shape reference. Suggested subsections (omit those that don't apply):

- **Breaking changes** (call these out first, prominently)
- **New packages**
- **New features**
- **Fixes**
- **Documentation**
- **Packages** — full lockstep table

Pull the change set with `git log v<PREV>..HEAD --oneline` to remind yourself what shipped. RELEASE_NOTES is a historical document — leave older sections (and any legacy naming like HAWC) untouched.

## 4. Final test + build

```
npm test
npm run build
```

Both must pass. If a remote-package change is in this release, also run the integration suite (excluded from `npm test`):

```
npm run test:integration --workspace @wc-bindable/remote
```

## 5. Commit + tag

Single commit and matching annotated tag:

```
git add packages/*/package.json package-lock.json RELEASE_NOTES.md
git commit -m "chore: release v<NEW>"
git tag -a v<NEW> -m "v<NEW>"
```

## 6. Dry-run the publish

Before any real publish, see exactly what tarballs would go up:

```
npm publish --workspaces --access public --dry-run
```

Skim the file list per package. Anything in `dist/` and `README.md`, nothing else (the `files` field in each `package.json` enforces this). If you see `node_modules/`, `tests/`, source `.ts`, or random tooling files, stop — fix the `files` field.

## 7. Publish (CONFIRM with the user first — irreversible)

```
npm publish --workspaces --access public
```

`--access public` is required for the `@wc-bindable` scope. The root `package.json` is `private`, so it is skipped automatically.

If npm rejects some packages mid-run:
- Do **not** unpublish or retry blindly. Published versions cannot be re-uploaded with different content.
- Check what landed: `npm view @wc-bindable/<name> versions` per package.
- Cut a follow-up patch (`<NEW>+1`) that ships only the missing packages. Don't try to "complete" a partial release at the same version.

## 8. Push commit + tag (CONFIRM with the user first)

```
git push origin <branch>
git push origin v<NEW>
```

## Failure recovery

- **Tests fail mid-release**, before tag/publish: `git restore packages/*/package.json package-lock.json RELEASE_NOTES.md` to drop the bumps. Nothing was published. Fix the underlying issue, retry the skill from step 1.
- **Tag already exists locally**: stop. Either an earlier attempt left state, or someone else cut the same version. Investigate `git tag --list 'v<NEW>'` and the remote before forcing.
- **Tag exists on remote**: do not force-push the tag. Cut a new patch version instead.

## Repo-specific notes

- README's package table lists `ai`, `auth0`, `s3` packages that do **not** exist on disk. Do not bump or publish phantom packages — `ls packages/` is the source of truth. Cross-check before step 1.
- `vitest.config.ts` aliases `@wc-bindable/core` and `@wc-bindable/remote` to source. Tests pass against source code, but the published artifact is `dist/` from `tsc`. If you change a public API surface, run `npm run build` and inspect the affected `dist/index.d.ts` before tagging.
- This skill does **not** create GitHub Releases or generate npm provenance / SLSA attestations. Add those when multi-contributor releases or supply-chain requirements demand it; until then, the manual flow above is the contract.
