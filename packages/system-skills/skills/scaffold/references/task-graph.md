# The first task graph

Plan it after the skeleton passes its check, so Owns paths are real. The task template, sizing and status flow are in clowdy:orchestrate; this file adds what is specific to a new application.

## Slice catalog

Take only the slices the first milestone needs. A slice is a coherent outcome one agent finishes in one run. Typical ones:

| Slice | Owns (typical) | Usually depends on |
| --- | --- | --- |
| Data model and storage (schema, migrations, queries, seed data) | database folder, migrations | skeleton |
| API (endpoints for one resource or a few related ones) | routes folder files for those resources | skeleton, and the data slice when it needs real tables; otherwise the contract |
| UI shell (layout, navigation, empty and error states, shared components) | shared UI folder, the layout file | skeleton |
| One feature screen end to end | that screen's folder | UI shell, and the API contract |
| Auth (sign-in, sessions, protected routes) | auth folder, one guard in the shell | skeleton; feature screens that need protection depend on it |
| Deployment script (build, publish, environment setup) | deploy folder, build config | skeleton |
| Demo data and an example account | seed script | the data slice |
| Background jobs, email, file uploads, payments | their own folder each | only when the milestone needs them |

Split by owned paths, not by activity. "Write tests" and "write docs" are not slices: tests belong to the code's slice, and each slice updates `product.md` and `architecture.md` for what it changes.

## Description of each task

Use the five-part template of clowdy:orchestrate (Outcome, Owns, Needs, Check, Out of scope). For a new app, Needs names the `architecture.md` section and the decision records to follow, and Check is a command plus the visible behavior. Also name the shared files the task may touch and the rule for each (copied from `architecture.md`).

## Dependencies

- `dependsOn` only for real ordering: the task needs another's output, or must edit the same files after it.
- Prefer removing a dependency by fixing the contract first. Write the API routes, the data tables and the shared types into `architecture.md` (Contracts). Then the API, the UI and the data slice start together: the UI builds against the contract with fixture data, the API against the schema.
- The skeleton is Done before any slice starts, so listing it in `dependsOn` costs nothing and shows the order to the user.
- A slice that others wait on is checked and set Done by you before its dependents start.

## Shared files

Lockfile, dependency manifest, route or module index, navigation, global styles, `.env.example`, README and `index.md` collide when several agents edit them.

- The skeleton removes most of them (discovered routes, one stylesheet per screen).
- Dependencies for the milestone are installed by the skeleton. A slice that needs another adds it once with the package manager's add command, names it in its report, and never upgrades others.
- `.env.example`: a slice appends its own variables on separate lines.
- `index.md` has one writer, the orchestrator. Slices report the paths of documents they create.

## Size

- Four to eight tasks for a first milestone. Past about twelve, group or stop at the milestone.
- Each task is 30 to 120 minutes of agent work: a run costs about 20k tokens of fixed overhead, so tiny tasks waste quota. Fold small parts into the slice that owns the code, or hand them to engine sub-agents inside it.
- A task that would end as "partly done", or has no single Check, is too big. Split it by owned paths.

## Example: bakery ordering

Milestone: a customer picks a cake and a pick-up slot and submits; the owner opens the admin page and sees the order. Contracts written first in `architecture.md`: `GET /menu`, `GET /slots`, `POST /orders {cakeId, slotId, name, phone}`, `GET /admin/orders`, and the three tables.

```text
CLW-1 Skeleton                              Done (check passes; /health answers)
CLW-2 Menu, slots and orders: storage + API  Owns: src/db/**, src/server/routes/**
        Check: endpoint tests; POST /orders then GET /admin/orders returns it
CLW-3 Customer ordering page                 Owns: src/web/order/**
        Needs: contract GET /menu, GET /slots, POST /orders (fixtures until CLW-2 lands)
        Check: component test; a headless run picks a cake and a slot and sees the confirmation
CLW-4 Owner login and orders list           Owns: src/web/admin/**, src/server/auth.*
        dependsOn: CLW-2
        Check: wrong password is refused; the list shows an order created through the API
CLW-5 Deployment script                      Owns: deploy/**
        Check: running it on a clean machine produces a build that starts and answers /health
```

CLW-2, CLW-3 and CLW-5 start at once (three `run_spawn` calls, keys `CLW-2-executor-1` and so on, in one message). CLW-4 starts when CLW-2 is Done. When all four are Done, a verifier bound to them walks the full milestone flow on the combined result (clowdy:verify); a failure goes back to the owning task with the exact step that broke.

## Replanning

Slices reveal facts. When one does (a missing table, a wrong contract, a slice that is bigger than thought), stop the affected runs, fix `architecture.md` Contracts first, then replan as in clowdy:orchestrate. Do not let two slices keep building against different versions of a contract.
