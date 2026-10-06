<!--
Keep this short. The checklist exists because this tool writes to live client
stores — the failure mode is not a red build, it's a merchant's order history.
-->

## What changed

## Why

## Verification

<!-- Paste actual output, not a claim that it passes. -->

```
$ npm test

```

- [ ] Offline suite passes: `npm test` = 1320 assertions, 0 failed (132 fixtures + 71 import-sim + 180 machine + 243 MCP + 630 dandomain + 64 probe-kit). Re-derive the number; do not copy it.
- [ ] Exercised against a dev store, or explicitly not applicable

## Invariants (ARCHITECTURE.md §Invariants)

Tick the ones this PR touches, and say how it stays true:

- [ ] **1. Idempotent imports** — re-running this import cannot duplicate
- [ ] **2. GraphQL only, one version pin** — new documents live in `src/shopify/mutations.js`
- [ ] **3. Rate limits learned, not hardcoded** — no plan-dependent numbers added
- [ ] **4. Destructive ops gate on store class** — `wipe` still refuses non-dev stores
- [ ] **5. PCD pre-flight before customers/orders**
- [ ] **6. Zero runtime dependencies, Node ≥ 20** — `package.json` still has no deps
- [ ] **7. cwd-independence** — package-relative paths come from `paths.js`
- [ ] **8. Non-TTY degradation** — piped output stays plain, interactive bits check `isTTY`
- [ ] **9. Interactive flows are drop-proof** — multi-question stdin uses the queued prompter
- [ ] None of the above

## Data safety

- [ ] Nothing writes to WordPress (the source stays intact for rollback)
- [ ] No credentials, client store names, or customer PII in the diff, fixtures, or test output
- [ ] Anything lossy emits a `warnings.jsonl` line instead of deciding silently

## Docs

- [ ] `PLAYBOOK.md` updated (operator-facing behavior changed)
- [ ] `ARCHITECTURE.md` updated (layer, invariant, or extension point changed)
- [ ] `README.md` updated (commands or key behaviors changed)
- [ ] No docs needed
