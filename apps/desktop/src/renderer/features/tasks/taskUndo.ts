import { toast, type ToastContent } from '@clowdy/components/Toast';

import { undoStack, type UndoEntry, type UndoStack } from '../../hotkeys/undo';
import { sendEach } from './commands';

import type { CommandResult, Task, TaskId } from '@clowdy/protocol';
import type { CommandInput } from '../../daemon/transport';
import type { ProjectState, RootStore } from '../../stores';

type TaskUpdate = Extract<CommandInput, { type: 'task.update' }>;

/** The fields `task.update` changes, which are the ones an undo puts back. */
const FIELDS = ['title', 'description', 'statusId', 'dependsOn', 'parentId'] as const;

type Field = (typeof FIELDS)[number];

/** The values of the fields, as `task.update` names them: `parentId` is `null` for a task that is a root, which is how the command detaches one. */
type Fields = Partial<Pick<Task, Exclude<Field, 'parentId'>>> & { parentId?: TaskId | null };

/** How long the offer to undo stays: longer than a plain toast, because it is a button the person has to reach for. */
const UNDO_TOAST_MS = 5000;

/** What one accepted update changed in one task: only the fields it changed, as they were and as they became. */
interface Change {
    taskId: TaskId;
    /** The key at the time: the task may be gone when the change is undone, and the message still names it. */
    key: string;
    before: Fields;
    after: Fields;
}

/**
 * A dependency is the same dependency wherever it sits in the list, so only the set counts. A root has no parent, which the task holds as nothing and the
 * command says as `null`: the two are the same value. Other fields compare as they are.
 */
function sameValue(field: Field, a: Fields[Field], b: Fields[Field]): boolean {
    if (field === 'parentId') return (a ?? null) === (b ?? null);

    if (field !== 'dependsOn') return a === b;

    const [x, y] = [a, b] as [TaskId[] | undefined, TaskId[] | undefined];

    return x !== undefined && y !== undefined && x.length === y.length && x.every(id => y.includes(id));
}

/** What `input` changes in `task`, read now, before the daemon has it: the previous values of exactly the fields that differ. Null when nothing does. */
function changeOf(input: TaskUpdate, task: Task | undefined): Change | null {
    if (!task) return null;

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    for (const field of FIELDS) {
        const next = input[field];

        if (next === undefined || sameValue(field, task[field], next)) continue;

        // A root is `null`, so putting it back detaches the task: an absent `parentId` would leave it where it is.
        const previous = field === 'parentId' ? task.parentId ?? null : task[field];

        // Copies, so the entry owns its lists: the store replaces a task on each event, and this must not depend on it never editing one in place.
        before[field] = Array.isArray(previous) ? [...previous] : previous;
        after[field] = Array.isArray(next) ? [...next] : next;
    }

    return Object.keys(after).length > 0 ? { taskId: task.id, key: task.key, before: before as Fields, after: after as Fields } : null;
}

/** Whether the task still holds what the change gave it. Anything else means someone has changed it since, and putting the old value back would overwrite that. */
function stillHolds(task: Task | undefined, after: Fields): boolean {
    return task !== undefined && (Object.keys(after) as Field[]).every(field => sameValue(field, task[field], after[field]));
}

/** The change in a few words, for the offer to undo it. One action never mixes fields today; if one did, it is only "updated". */
function describeChanges(project: ProjectState, changes: readonly Change[]): string {
    const [first] = changes;
    const subject = changes.length === 1 ? first.key : `${ changes.length } tasks`;
    const fields = new Set(changes.flatMap(change => Object.keys(change.after) as Field[]));

    if (fields.size !== 1) return `${ subject } updated`;

    const [field] = fields;

    if (field === 'title') return `Renamed ${ subject }`;
    if (field === 'description') return `Description of ${ subject } changed`;
    if (field === 'dependsOn') return `Dependencies of ${ subject } changed`;
    if (field === 'parentId') return `Parent of ${ subject } changed`;

    // Every task moved to the same status, which is then worth naming. A selection that steps along the workflow ends in several.
    const targets = new Set(changes.map(change => change.after.statusId));
    const name = targets.size === 1 ? project.statuses.find(status => status.id === first.after.statusId)?.name : undefined;

    return name ? `${ subject } moved to ${ name }` : `${ subject } moved`;
}

/** The key of the toast of the latest change, so the next one replaces it: five quick moves must not stack five toasts. */
let lastToast: string | undefined;

function showToast(kind: 'show' | 'success', content: ToastContent): string {
    if (lastToast) toast.queue.close(lastToast);

    lastToast = toast[kind](content);

    return lastToast;
}

function staleMessage(stale: readonly Change[], restoredAny: boolean): string {
    const subject = stale.length === 1 ? stale[0].key : `${ stale.length } tasks`;

    if (!restoredAny) return `${ subject } changed since, so this cannot be undone`;

    return stale.length === 1 ? `${ subject } changed since and was left as it is` : `${ subject } changed since and were left as they are`;
}

/**
 * Puts the previous values back, task by task, for the tasks that still hold what the change gave them. A task someone changed since (another edit,
 * an agent, a daemon event) is left alone and said so. Resolves to whether anything was put back; a refusal by the daemon shows its own toast.
 */
async function restore(root: RootStore, project: ProjectState, changes: readonly Change[], label: string): Promise<boolean> {
    const holds = (change: Change) => stillHolds(project.tasks.get(change.taskId), change.after);
    const fresh = changes.filter(holds);
    const stale = changes.filter(change => !fresh.includes(change));

    if (stale.length > 0) toast.error({ message: staleMessage(stale, fresh.length > 0) });

    if (fresh.length === 0) return false;

    const inputs: TaskUpdate[] = fresh.map(({ taskId, before }) => ({ type: 'task.update', taskId, ...before }));
    const results = await sendEach(root, inputs);
    const restored = results.filter(result => result.ok).length;

    if (stale.length === 0 && restored === inputs.length) showToast('success', { message: `Undone: ${ label }` });

    return restored > 0;
}

/** Records one entry for the changes and offers the undo in a toast. The toast and the stack run the same entry. */
function record(root: RootStore, project: ProjectState, stack: UndoStack, changes: readonly Change[]): void {
    const label = describeChanges(project, changes);
    let offer: string | undefined;
    const entry: UndoEntry = {
        scope: project.id,
        label,
        undo: async () => {
            // Out of the way before anything it says about the undo.
            if (offer) toast.queue.close(offer);

            return restore(root, project, changes, label);
        },
    };

    stack.push(entry);
    offer = showToast('show', { message: label, timeout: UNDO_TOAST_MS, action: { label: 'Undo', onPress: () => void stack.undoEntry(entry) } });
}

/**
 * Sends the commands like `sendEach` and, for the `task.update`s the daemon accepted, records one undo entry for the whole action and shows its toast.
 * A bulk change over a selection is one entry. Every change a person makes to a task goes through here (the keys, the drag, the panel), so recording is in one place.
 * The previous values are read before anything is sent. A refused change records nothing, and neither does anything but `task.update`: delete and start cannot be taken back.
 * At most one update per task, so each previous value is the one before this action.
 */
export async function sendWithUndo(root: RootStore, project: ProjectState, inputs: readonly CommandInput[], stack: UndoStack = undoStack): Promise<CommandResult[]> {
    const pending = inputs.map(input => (input.type === 'task.update' ? changeOf(input, project.tasks.get(input.taskId)) : null));
    const results = await sendEach(root, inputs);
    const changes = pending.flatMap((change, index) => (change && results[index]?.ok ? [change] : []));

    if (changes.length > 0) record(root, project, stack, changes);

    return results;
}
