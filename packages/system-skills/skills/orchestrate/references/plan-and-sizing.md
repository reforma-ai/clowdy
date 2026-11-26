# Planning tracked work

Create a task when someone needs to track, coordinate or resume the work. Use the existing task when the chat started from one. A quick fix or a question needs no task just for the record.

## Shape the work

- Make each task a useful outcome that can be checked. Keep the title clear; briefly describe the result and how to verify it. Add constraints, ownership, context or exclusions when they help the next person. No fixed template is required.
- Split work into tasks when the pieces need separate tracking, ordering or ownership. Use `--parent` to group stages of a larger outcome. A checklist (`- [ ]`) is enough for steps inside a task. A thread or reviewer can work on an existing task; neither automatically needs a new one.
- Use `--depends-on` only when one task truly needs another first. Run independent work together when contracts and file ownership allow it; otherwise sequence it. An open task is ready when its dependencies are Done or Canceled. A canceled dependency releases its dependents, so check that they can still proceed.
- The parent task is the whole, not an automatic dependency on its children. Start ready stages and close the parent only after the whole is verified. The parent chooses direct work or delegation and integrates the result.

## Keep the board useful

Use the project's actual statuses. Move tracked work to In progress when started, Review when ready for review, and Done after the required checks and review. If verification fails, return it to In progress. Cancel dropped work with a reason; record blockers and useful findings on the task. Update the plan and dependencies when the work changes.

Use `clowdy task --help` for commands and `clowdy task <command> --help` for options. Search existing tasks before starting tracked work when overlap is possible. Assign a task owner with `clowdy thread spawn --tasks <key>`; a reviewer may read the task for context without being assigned or changing its status.
