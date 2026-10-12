---
name: local-model
description: Work with prooph board models through spec-stream. Use this skill to inspect, edit, validate, test, and synchronize a local model copy safely.
---

# Local Model: Working with prooph board through spec-stream

Use this skill whenever a task requires reading or changing a prooph board model through its local file representation.

This skill covers the **local workflow and file mechanics**. It does not define how to model a business process. For modeling decisions, also load the relevant methodology skill, such as `event-modeling`.

For the complete file tree layout, every JSON schema, field types and allowed values, `play-function.ts` / `play-type.ts` signatures, and the step-by-step scenario guide, see [`MODEL_SCHEMA.md`](./MODEL_SCHEMA.md).

## Core rules

1. **Near real-time refresh.** The live prooph board is the source of truth. The local copy is updated near real-time with the help of `npx @proophboard/spec-stream run` running in the background. The user has to run it, if you detect that your changes are not synced, provide a hint to the user that spec-stream is maybe not running or has technical problem.
2. **Treat the local model as a working copy, not a second source of truth.** Make changes in the local model and use `npx @proophboard/spec-stream sync-back` to synchronize them back.
3. **Never edit generated or mirrored files directly.** In particular, do not edit `index.md`, `uuid-index.json`, `workspace.json`, or anything under `element-details/`.
4. **Validate before sync-back.** Run model validation, inspect the proposed changes, then synchronize.
5. **Treat deletions as destructive.** Deleting a primary entity JSON file can delete that entity from prooph board. Never delete files as a cleanup shortcut.
6. **Do not assume a successful local edit means the board is updated.** Changes reach prooph board only after sync-back succeeds.

## 1. Locate the model

By default, `spec-stream run` writes the local model to:

```text
.spec-stream/model/
```

The directory can be changed through the `localSync.dir` configuration. Check the project configuration and existing files rather than assuming the default path.

Typical structure:

```text
.spec-stream/model/
  workspace.json
  uuid-index.json
  chapters/
    [Context]/
      [Chapter]/
        chapter.json
        index.md
        slices/
          [NNNN]_[Slice]/
            slice.json
            details.md
            lanes/
              [laneType]/
                [Lane]/
                  lane.json
                  elements/
                    [NNNN]_[Element]/
                      element.json
                      description.md
                      details.md
                      play-function.ts
                      play-type.ts
        scenarios/
          [Scenario]/
            scenario.json
  element-details/
    [Context]/[type]/[Name]/details.md
  milestones/
    [Milestone]/
      milestone.json
      description.md
  html-snippets/
    [slug].html
    [slug].json
```

Some optional files or directories appear only when the corresponding content exists.

### Navigating the tree

- Names in directory paths are sanitized slugs. The raw names are stored in the corresponding JSON files.
- Slice and element directories have zero-padded numeric prefixes that reflect their board order.
- Lane directories are not numerically prefixed; use `lane.json`'s `index` to determine lane order.
- A lane directory is materialized only for slices that contain elements in that lane.
- `uuid-index.json` maps UUIDs to relative paths. Use it to find an entity from an ID returned by another tool or present in a reference.
- Read the relevant entity JSON before changing its name, type, placement, status, or other structured properties. Do not infer those values from the directory name alone.

## 2. Know which files are safe to edit

### Generated or mirrored: do not edit

| Path | Reason |
|---|---|
| `index.md` | Generated chapter summary; overwritten on sync |
| `uuid-index.json` | Generated UUID-to-path index |
| `workspace.json` | Generated workspace metadata |
| `element-details/` | Mirror of canonical shared element details; edit the element placement's `details.md` instead |

Do not try to make a change persist by editing a generated file. Change the appropriate editable source file and let `spec-stream` regenerate its outputs.

### Editable files

| File | Represents |
|---|---|
| `chapter.json` | Chapter name and context |
| `slice.json` | Slice label and status |
| Slice `details.md` | Slice details |
| `lane.json` | Lane label, index, and height |
| `element.json` | Element name, type, and placement properties such as `laneId`, `sliceId`, and index |
| Element `description.md` | Short, placement-specific sticky-note description |
| Element `details.md` | Shared rich details for the element |
| `play-function.ts` | Exploration Mode handler for a command or event |
| `play-type.ts` | Command/event payload type |
| `scenario.json` | Scenario definition, interactions, and expectations |
| `milestone.json` / `description.md` | Milestone properties and description |
| HTML snippet files | HTML snippet content and associated metadata |

Use the existing file format and nearby examples. Do not invent fields or reshape JSON without checking the project's existing model files and schema/reference documentation.

### Important distinction: element description vs. details

- `description.md` is short text for the particular placement of an element.
- Element `details.md` is shared by synchronized placements of the same element. Editing it can affect other chapters too.
- Slice-specific behavior and Given/When/Then material belong in the **slice details**, not in shared element details.
- Do not edit `element-details/` directly.

## 3. Make a focused change

Before editing:

1. Identify the exact chapter, slice, lane, element, or scenario involved.
2. Read the relevant JSON and Markdown files, including nearby examples.
3. Use `uuid-index.json` to resolve IDs to paths when needed.
4. Check whether the change affects a shared element or other chapters.
5. Keep the diff limited to the requested change.

When creating entities, follow the existing directory and JSON conventions. New files may represent new entities during sync-back; make sure references, names, and paths are consistent. Do not manually update generated indexes.

For `play-function.ts`, use named exports (`decide` and/or `apply`), not a default export. For `play-type.ts`, write a complete TypeScript type alias, for example:

```typescript
type Payload = {
  title: string;
  until?: string;
}
```

The `type Payload =` prefix is stripped by sync-back where required, so keep the full alias in the local file.

For scenarios, follow existing `scenario.json` examples. Validate the references used by interactions and expectations, and test the scenario before synchronizing when scenario behavior is part of the change.

## 4. Validate the local model

Run the model validator before sync-back:

```sh
npx @proophboard/spec-stream model validate
```

Use verbose output when diagnosing issues:

```sh
npx @proophboard/spec-stream model validate --verbose
```

The validator checks, among other things:

- JSON files parse correctly.
- Element `laneId` and `sliceId` references resolve through `uuid-index.json`.
- Scenario expectation references resolve to known slice and element IDs.
- UUIDs are not duplicated across different directories.
- Directory slugs match the sanitized names in the corresponding JSON.

Resolve validation errors rather than bypassing them. If a validation result appears inconsistent with the files, inspect the relevant paths and references before continuing.

If the change involves scenarios, run the scenario test command against the relevant chapter path:

```sh
npx @proophboard/spec-stream scenario test --chapter <chapter-path>
```

Replace `<chapter-path>` with the actual chapter directory.

## 5. Synchronize changes

When the model is valid, synchronize:

```sh
npx @proophboard/spec-stream sync-back
```

Sync-back translates local changes into prooph board API calls. Modified files update the corresponding board entities; added files can create entities; deleting a primary entity JSON file can delete that entity. If sync-back exits non-zero, inspect the error, correct the underlying issue, and rerun validation before retrying.

After a successful sync-back, check the command result.

## 6. Avoid common mistakes

- **Editing generated output:** Change source files, not `index.md`, indexes, workspace metadata, or the mirrored `element-details/` tree.
- **Editing by slug alone:** Slugs are for paths; use JSON for the actual name and properties.
- **Ignoring shared details:** Element details may be shared across placements and chapters.
- **Deleting files casually:** A deleted primary JSON file may delete the corresponding board entity.
- **Treating local validation as a board sync:** Validation checks the local model; sync-back is a separate operation.
- **Changing methodology in this skill:** Use the relevant modeling skill for business and modeling rules.

## Completion checklist

Before declaring a model change complete:

- [ ] Only intended editable files were changed.
- [ ] Generated and mirrored files were left untouched.
- [ ] Shared element details and cross-chapter effects were considered.
- [ ] `@proophboard/spec-stream model validate` passes.
- [ ] Relevant scenarios were tested.
- [ ] Sync-back completed successfully.
