# Display label overlays

Optional, app-side presentation data. One file per task: `<task_id>.json`.

The console derives every structural fact from the canonical workflow root. These
files only supply nicer display strings for identifiers, and are consulted last:

1. the canonical data itself (a path memory heading, a `mechanism_class`, a goal objective)
2. this overlay
3. the raw identifier

If no overlay exists for a task the console shows raw identifiers. It never
invents prose, and it never reads or writes these files inside a workflow root.

```json
{
  "task_id": "TASK-EXAMPLE-001",
  "goals":  { "L1-STRUCTURE": "结构与授权" },
  "edges":  { "EDGE-01-STRUCTURE": { "label": "结构路径", "shortLabel": "结构" } },
  "paths":  { "PATH-STRUCTURE-01": { "label": "线性守卫状态机", "summary": "..." } }
}
```

`goals`, `edges` and `paths` accept either a bare string (treated as `label`) or an
object with `label`, `shortLabel` and `summary`.
