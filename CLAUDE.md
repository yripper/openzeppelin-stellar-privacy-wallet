# CLAUDE.md

Instructions for AI agents working in this repository.

## Module Documentation Convention (MANDATORY)

Every module has a living doc at `docs/modules/<module>.md` (flat file, one per module). `docs/modules/README.md` is the index that routes a module's source path → its doc. These are the fast on-ramp for anyone — human or agent — touching a module.

**Progressive disclosure — do NOT load all docs at once.** When you're about to touch a module, open `docs/modules/README.md`, find the ONE doc matching the code you're changing, and read only that. Never pull the whole `docs/modules/` folder into context.

**The workflow rule:**
1. **Before modifying a module, read its `docs/modules/<module>.md` first.** It holds the file map, key methods with `file:line`, dependencies, and gotchas.
2. **After modifying a module, update its doc in the same change.** New/removed endpoints, changed behavior, new gotchas, dependency changes — all go into the doc before the work is done. Bump the "Last verified" date.
3. Doc claims must be verified against source and cite `file:line`. Never document something you haven't confirmed exists.
4. **Adding a new module?** Create its `docs/modules/<module>.md` and add a row to `docs/modules/README.md` in the same change.

Docs follow a shared template: Purpose, Structure, Endpoints/Public surface, Key methods (`file:line`), Dependencies, Gotchas & invariants, Testing.
