---
description: Autonomous goal - build six playable art lessons for kids about renowned artists, improving agent-meshes as you go
argument-hint: "[status | plan | <artist-slug> | tool:<backlog-id>]"
---

# Goal: Art Explorers

Build **at least six playable art education experiences** for kids aged 8 to 12. Each one takes
the technique of a renowned artist and lets a kid explore it through models, rigs, animation and
color produced by agent-meshes. Use the exercise to find and fix weaknesses in the tool. Improve
the tool as you go, then improve and refine the lessons.

You are running autonomously. Nobody will answer questions mid-run. Do not call the
AskUserQuestion tool for any reason. Where a skill asks you to confirm with the user, including
ship-it's merge confirmation, this file is that confirmation. Where this file leaves a decision
open, make the reasonable call, record it in the ledger, and continue. Do not end your turn after
a milestone; keep working until a stop condition or the done criteria are met, then report.

Argument: `$ARGUMENTS`. Empty means resume from the ledger. `status` means print the ledger summary
and stop. `plan` means run bootstrap and artist selection, then stop before building. An artist
slug means work only that lesson. `tool:<id>` means work only that backlog entry.

## Where things live

| Thing | Location |
| ----- | -------- |
| Tool source (this repo) | `C:\Users\ehart\repos\agent-meshes` |
| Gallery repo (sibling checkout) | `C:\Users\ehart\repos\art-explorers` |
| GitHub | private repo `ehartye/art-explorers`, Pages from `main` at `/` |
| Ledger (all resumable state) | `art-explorers/LEDGER.md` |
| Kid-test rubric | `art-explorers/RUBRIC.md` |
| Lesson sources (operations, recipes, build config) | `art-explorers/lessons/<slug>/source/` |
| Lesson page and built assets | `art-explorers/lessons/<slug>/` (`index.html`, `model.glb`, PNGs) |
| Shared embed runtime | `art-explorers/lib/` (copied from an agent-meshes build, never hand edited) |
| Evidence screenshots and check output | `art-explorers/evidence/<slug>/` |
| Tool change notes and architecture | the wiki, via `wiki-master:wiki-author` |

The gallery repo holds static output plus lesson prose. It may carry a `package.json` with
dev-only tooling (Playwright) for checks. The published site must never need a build step.

## Resume protocol

Every run starts here, including the first one.

1. Read `LEDGER.md` if it exists. It has four tables: **Decisions**, **Artists**, **Lessons**,
   **Tool backlog**. Each lesson row has a phase: `chosen`, `modeled`, `paged`, `verified`,
   `passed`, `published`, `parked`.
2. Check both repos are clean and on a known branch. In-flight rebase or merge means stop and
   report.
3. Pick the next action in this order: an open stop condition, a lesson below `published`, an
   unworked backlog entry that meets the work rule, a refinement pass not yet done.
4. Update the ledger after every phase change, before moving on. The ledger is the source of
   truth, not this conversation.

## Phase 0: Bootstrap (once)

Skip any step the ledger marks done.

1. Create the gallery repo if it does not exist:
   ```bash
   gh repo create ehartye/art-explorers --private --clone --description "Playable art lessons for kids, built with agent-meshes"
   ```
   Clone to the sibling path above. Add `.nojekyll`, a README that says what the site is and
   that lesson sources are in `lessons/<slug>/source/`, and a placeholder `index.html`.
2. Enable Pages from `main` at `/`:
   ```bash
   gh api -X POST repos/ehartye/art-explorers/pages -f 'source[branch]=main' -f 'source[path]=/'
   ```
   The owner's GitHub plan supports Pages on private repos, so this should succeed. If GitHub
   still refuses, **stop** and report the exact error. Do not make the repo public yourself.
3. Wait for the Pages URL to serve the placeholder. Record the URL in Decisions.
4. Write `RUBRIC.md` (section below) before any lesson exists. Commit.
5. Add `scripts/check.mjs` to the gallery with Playwright as a dev dependency. It takes a lesson
   slug, loads `lessons/<slug>/index.html` offline in Chromium, fails on any console error,
   screenshots at 390 px and 1200 px, checks the reduced-motion start state and total page
   weight, and writes everything to `evidence/<slug>/`. Model it on
   `scripts/check-creatures.mjs` in this repo. Test it against the placeholder index.
6. Produce the shared embed runtime. agent-meshes currently inlines its preview bundle into each
   `preview.html`, so there may be no standalone file to copy. If so, that is backlog entry 1,
   class `blocker`: add a build output or CLI command that emits the runtime as one JS file with
   a documented script API. Ship it through the tool improvement rule before the first lesson
   page. Copy the result to `lib/` and record its agent-meshes commit in Decisions.
7. Record in Decisions: the gallery repo Pages URL is reachable by anyone who has it, even though
   the repo is private. Lesson content must be fine to share.

## Kid-test rubric

Write this to `RUBRIC.md` on bootstrap. Every lesson must pass every line to reach `passed`.
Each line is scored pass or fail with one sentence of evidence.

**Teaching**
- Names one artist and one technique in the first screen, in words an eight-year-old reads.
- The kid does something with the technique, not just watches it. At least one activity changes
  the model, pose, motion or color and the page reacts.
- The page ends with one thing the kid can try away from the screen, with paper or objects.
- Nothing on the page is false about the artist. Dates and claims are checked against two sources
  and cited in the lesson source folder, not on the page.

**Reading and tone**
- One idea per screen. No screen has more than three sentences of body text.
- Sentences average under twelve words. No word a ten-year-old would need to look up without a
  one-line gloss beside it.
- Tone is warm and direct. No baby talk, no exclamation marks in a row, no "fun fact".

**Play**
- Works with mouse and with touch. Controls are at least 44 px on a side.
- First interaction is reachable within five seconds of load with no reading required.
- The activity has a visible outcome the kid can compare to the artist's real work, described in
  words or a simple drawing. No copyrighted images of the work are embedded.

**Technical**
- Loads offline from the file system in Chromium with zero console errors.
- Renders in a 390 px wide viewport without horizontal scroll.
- Respects `prefers-reduced-motion` by starting paused.
- Total page weight under 6 MB including the GLB.

## Phase 1: Artist selection

Shortlist at least ten renowned artists. For each, write a **fit score** across four axes the
tools can express: form (primitives, proportion, silhouette), motion (rigs, gaits, clips),
structure (hierarchy, balance, repetition) and color (part colors, palettes). Score 0 to 3 each.
Reject any artist whose technique lives mostly in surface, texture, brushwork or 2D perspective,
however famous. Record the whole shortlist with scores and one line of reasoning per artist in
the Artists table, including the rejects.

Choose six with the highest fit that together cover all four axes at least twice. Prefer artists
who are less commonly taught to kids when fit ties. Sculptors, kinetic artists, motion
photographers and geometric abstractionists usually fit. Painters known for brushwork usually
do not. Do not choose two artists whose lessons would teach the same idea.

For each chosen artist write the lesson's one-sentence promise: "After this, a kid can ___."

## Phase 2: Lesson loop

Run this per artist. Advance the ledger phase at each step.

**Model** (`chosen` to `modeled`). Author the model in agent-meshes as an operations batch or a
recipe under `lessons/<slug>/source/`. Use a workspace: `--workspace .agent-meshes/<slug>`.
Include at least one clip when motion is an axis. Build with `build build.json` from this repo
and verify the GLB. Copy `model.glb`, PNGs and `project.mesh.json` into the lesson folder.

**Page** (`modeled` to `paged`). Write `index.html` as one self-contained page using the shared
embed runtime in `lib/`. Structure as screens the kid moves through, not a scrolling essay. Load
the `hartye-skills:beautiful` skill before writing any page. Every lesson shares the site's
palette and type so the six read as one thing. Add the lesson to the gallery `index.html`.

**Verify** (`paged` to `verified`). Run the gallery check script against the lesson: offline
Chromium load, console errors, 390 px and 1200 px screenshots, reduced-motion start state, page
weight. Write output to `evidence/<slug>/`. A failing check is a bug to fix now.

**Score** (`verified` to `passed`). Score every rubric line with evidence. Write the scorecard
to `evidence/<slug>/rubric.md`. Any fail returns the lesson to `paged`. After three rounds
without passing, mark it `parked` with the blocking line, and continue with other lessons.
Parked lessons do not count toward six, so choose a replacement from the shortlist.

**Publish** (`passed` to `published`). Commit to a feature branch in the gallery repo, push, open
a PR, merge on green, and confirm the lesson URL serves from Pages. Record the URL.

Do not build all six models first and page them later. One lesson through to `published` teaches
more about the tools than six half-done ones.

## Phase 3: Refinement passes

After six lessons are `published`, run two passes and record each in Decisions.

1. **Consistency.** Open all six side by side. Align navigation, palette, control placement,
   reading level and screen count. A kid who finished one should know how to use the next.
2. **Rubric re-score.** Score every lesson again from scratch. Tool improvements shipped since a
   lesson passed may have changed its behavior. Fix, verify and republish anything that regressed.

## Tool improvement rule

While working a lesson, any friction with agent-meshes becomes a **backlog entry**: an id, one
sentence, the lesson that hit it, and a class from `blocker`, `missing`, `awkward`, `bug`. Do not
work around a `blocker` in the lesson page. Fix the tool.

Work an entry when it is a `blocker`, a `bug`, or when two lessons have hit it. Everything else
waits. When working one:

1. Branch in this repo from up-to-date `main` as `<type>/<kebab-summary>`.
2. Follow `h-superpowers:test-driven-development`. A failing test before the change.
3. Run `npm run typecheck` and `npm test`. Both clean.
4. Ship with `hartye-skills:ship-it`. **Merge on green CI is pre-authorized for this goal.** The
   owner approved that policy when defining this goal. Wait for checks, confirm the PR state is
   `MERGED` before deleting the remote branch, and sync `main`.
5. Rebuild any lesson that used the changed path and re-verify it.
6. Record what shipped in the wiki with `wiki-master:wiki-author` and close the backlog entry
   with the PR number.

A likely first entry: the preview runtime exposes play, clip choice and scrub, but a lesson has
no way to pose a bone, recolor a part, swap a clip on a slider, or read back a joint angle from
script. Confirm this by trying it in the first lesson before assuming it.

Tool changes must not break the five existing creatures. `npm run examples` and
`npm run check:creatures` are part of the check for any change to export, preview or render.

## Rails

- Never `--force` push, never rewrite pushed history, in either repo.
- Never make `art-explorers` public. Never change the HAL9000 tailnet route or anything under
  `artifacts/creatures`.
- No services beyond GitHub. No external images of artworks. No tracking scripts.
- Never commit to `main` directly in either repo. Feature branch, PR, merge.
- `ship-it` merge is pre-authorized only for the two repos named here.
- Keep token use proportionate: one subagent for a parallel verify is fine, a fleet is not.

## Stop conditions

Stop and report, naming the phase reached and what remains:

- Pages cannot be enabled on the private repo.
- A push is rejected, a merge is blocked, or CI fails twice in a row on the same change.
- Fewer than six artists survive the fit test with a lesson promise you believe in.
- Any lesson requires content you are not confident is accurate after checking two sources.
- Both repos have been touched by someone else since the ledger was last written.

## Done

Report done only when all of these are true and the ledger says so:

- At least six lessons are `published` with a live Pages URL each.
- Every published lesson has a rubric scorecard with all lines passing and evidence screenshots
  committed.
- The gallery index links every published lesson and passes the technical rubric lines itself.
- Both refinement passes are recorded.
- Every `blocker` and `bug` backlog entry is closed with a PR number, and remaining entries are
  listed in the final report with a recommendation each.
- The wiki has a page for the Art Explorers architecture and one per shipped tool change.

The final report lists the six artists with their lesson promise and URL, the tool changes
shipped, the backlog left open, and what you would do with a seventh lesson.
