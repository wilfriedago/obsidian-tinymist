## What this changes

<!-- What it does, and why this was the right way to do it. If you rejected an
     alternative, say which and why — that is the part reviewers cannot
     reconstruct later. -->

Closes #

## How it was verified

<!-- Tick what applies. -->

- [ ] `pnpm lint && pnpm lint:obsidian && pnpm typecheck && pnpm test`
- [ ] Added a test that fails without this change
- [ ] Exercised in a real Obsidian vault (say which parts — the automated
      suite cannot reach the UI, and that is where most bugs have been)
- [ ] Not applicable, because:

## Checklist

- [ ] `CHANGELOG.md` updated under **Unreleased**, if this is user-visible
- [ ] Docs updated, if behaviour or setup changed
- [ ] No new Node module imported outside `src/platform/desktop.ts`
- [ ] No new runtime dependency, or the pull request explains why one is needed
- [ ] Version numbers untouched — releases are a separate, maintainer-only step
