# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the
actual label strings used in this repo's issue tracker (the Meerkat TaskPanel board).

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding
label string from this table.

## Applying a label here

A label is named on a card, not created first:

```bash
taskctl issue update <ref> --label needs-triage     # repeatable
taskctl issue list --label needs-triage --json
taskctl labels list                                 # read-only registry
```

The registry is read-only through the CLI and grows when a card first names a label, so there
is no label-creation step to run. Edit the "Label in our tracker" column if the project adopts
a different vocabulary.
