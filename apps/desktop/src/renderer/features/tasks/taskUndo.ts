import { type ToastContent, toast } from '@clowdy/components/Toast';

import { type UndoEntry, type UndoStack, undoStack } from '../../hotkeys/undo';
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
        const previous = field === 'parentId' ? (task.parentId ?? null) : task[field];

        // Copies, so the entry owns its lists: the store replaces a task on each event, and this must not depend on it never editing one in place.
        before[field] = Array.isArray(previous) ? [...previous] : previous;
        after[field] = Array.isArray(next) ? [...next] : next;
    }

    return Object.keys(after).length > 0
        ? { taskId: task.id, key: task.key, before: before as Fields, after: after as Fields }
        : null;
}

/** Whether the task still holds what the change gave it. Anything else means someone has changed it since, and putting the old value back would overwrite that. */
function stillHolds(task: Task | undefined, after: Fields): boolean {
    return (
        task !== undefined &&
        (Object.keys(after) as Field[]).every(field => sameValue(field, task[field], after[field]))
    );
}

/** The change in a few words, for the offer to undo it. One action never mixes fields today; if one did, it is only "updated". */
function describeChanges(project: ProjectState, changes: readonly Change[]): string {
    const [first] = changes;
    const subject = changes.length === 1 ? first.key : `${changes.length} tasks`;
    const fields = new Set(changes.flatMap(change => Object.keys(change.after) as Field[]));

    if (fields.size !== 1) return `${subject} updated`;

    const [field] = fields;

    if (field === 'title') return `Renamed ${subject}`;
    if (field === 'description') return `Description of ${subject} changed`;
    if (field === 'dependsOn') return `Dependencies of ${subject} changed`;
    if (field === 'parentId') return `Parent of ${subject} changed`;

    // Every task moved to the same status, which is then worth naming. A selection that steps along the workflow ends in several.
    const targets = new Set(changes.map(change => change.after.statusId));
    const name =
        targets.size === 1 ? project.statuses.find(status => status.id === first.after.statusId)?.name : undefined;

    return name ? `${subject} moved to ${name}` : `${subject} moved`;
}

/** The key of the toast of the latest change, so the next one replaces it: five quick moves must not stack five toasts. */
let lastToast: string | undefined;

function showToast(kind: 'show' | 'success', content: ToastContent): string {
    if (lastToast) toast.queue.close(lastToast);

    lastToast = toast[kind](content);

    return lastToast;
}

/** Says that a change was taken back, in the toast the offer to undo it gave way to. */
export function showUndone(label: string): void {
    showToast('success', { message: `Undone: ${label}` });
}

function staleMessage(stale: readonly Change[], restoredAny: boolean): string {
    const subject = stale.length === 1 ? stale[0].key : `${stale.length} tasks`;

    if (!restoredAny) return `${subject} changed since, so this cannot be undone`;

    return stale.length === 1
        ? `${subject} changed since and was left as it is`
        : `${subject} changed since and were left as they are`;
}

/**
 * Puts the previous values back, task by task, for the tasks that still hold what the change gave them. A task someone changed since (another edit,
 * an agent, a daemon event) is left alone and said so. Resolves to whether anything was put back; a refusal by the daemon shows its own toast.
 */
async function restore(
    root: RootStore,
    project: ProjectState,
    changes: readonly Change[],
    label: string
): Promise<boolean> {
    const holds = (change: Change) => stillHolds(project.tasks.get(change.taskId), change.after);
    const fresh = changes.filter(holds);
    const stale = changes.filter(change => !fresh.includes(change));

    if (stale.length > 0) toast.error({ message: staleMessage(stale, fresh.length > 0) });

    if (fresh.length === 0) return false;

    const inputs: TaskUpdate[] = fresh.map(({ taskId, before }) => ({ type: 'task.update', taskId, ...before }));
    const results = await sendEach(root, inputs);
    const restored = results.filter(result => result.ok).length;

    if (stale.length === 0 && restored === inputs.length) showUndone(label);

    return restored > 0;
}

/**
 * How long after a description edit the next one of the same task still counts as part of it: as long as the offer to undo stays on screen. A person who ticks
 * five boxes one after another, each saved at once, takes them back with one Undo; an edit made later, or after anything else, is a step of its own, and so is
 * one that starts from a text the entry never had (`Joinable.texts`).
 */
const JOIN_WINDOW_MS = UNDO_TOAST_MS;

/** The latest entry that is only a change of one task's description, which the next change of that description joins while the window is open. */
interface Joinable {
    stack: UndoStack;
    entry: UndoEntry;
    change: Change;
    /**
     * The descriptions the task held while the entry was made: the one before its first change and the one each change gave it. An edit that starts from another
     * text means someone else (an agent, another window) wrote in between, and undoing both together would take their text away, so it is an entry of its own.
     * The text before an edit is what the store showed when it was sent, which may be one change behind (the daemon's event comes after its reply), hence all of them.
     */
    texts: Set<string>;
    /** The key of the toast that offers this entry's undo, the one the entry closes when it runs. */
    offer: { key?: string };
    at: number;
}

let joinable: Joinable | undefined;

/** Whether the changes are one task's description and nothing else. */
const isDescriptionEdit = (changes: readonly Change[]): boolean =>
    changes.length === 1 && Object.keys(changes[0].after).join() === 'description';

const descriptionOf = (fields: Fields): string => fields.description ?? '';

/** The entry a change of a description joins: the latest of its project, a description change of the same task, made inside the window, from a text the entry knows. */
function joinTarget(stack: UndoStack, project: ProjectState, changes: readonly Change[]): Joinable | undefined {
    const latest = stack.entries.findLast(entry => entry.scope === project.id);

    return joinable &&
        isDescriptionEdit(changes) &&
        joinable.stack === stack &&
        joinable.entry === latest &&
        joinable.change.taskId === changes[0].taskId &&
        joinable.texts.has(descriptionOf(changes[0].before)) &&
        Date.now() - joinable.at < JOIN_WINDOW_MS
        ? joinable
        : undefined;
}

function offerUndo(stack: UndoStack, entry: UndoEntry): string {
    return showToast('show', {
        message: entry.label,
        timeout: UNDO_TOAST_MS,
        action: { label: 'Undo', onPress: () => void stack.undoEntry(entry) },
    });
}

/**
 * Records one entry for the changes and offers the undo in a toast. The toast and the stack run the same entry. A change of a description that follows another
 * one of the same task inside `JOIN_WINDOW_MS`, with nothing recorded in between and starting from a text that entry has held, is part of that entry: it keeps
 * what the description was before the first and takes the new text as its result, and the offer is shown again.
 */
function record(root: RootStore, project: ProjectState, stack: UndoStack, changes: readonly Change[]): void {
    const joining = joinTarget(stack, project, changes);

    if (joining) {
        joining.change.after = changes[0].after;
        joining.texts.add(descriptionOf(changes[0].after));
        joining.at = Date.now();
        joining.offer.key = offerUndo(stack, joining.entry);

        return;
    }

    const label = describeChanges(project, changes);
    const { entry, offer } = pushEntry(stack, project.id, label, () => restore(root, project, changes, label));

    joinable = isDescriptionEdit(changes)
        ? {
              stack,
              entry,
              change: changes[0],
              texts: new Set([descriptionOf(changes[0].before), descriptionOf(changes[0].after)]),
              offer,
              at: Date.now(),
          }
        : undefined;
}

/**
 * Puts an entry on the stack and offers its undo in a toast: the toast and the stack run the same entry, and the entry closes its toast when it runs, so the
 * offer is out of the way before anything the undo says. Returns what a join needs to show the offer again.
 */
function pushEntry(
    stack: UndoStack,
    scope: string,
    label: string,
    undo: () => Promise<boolean>
): { entry: UndoEntry; offer: Joinable['offer'] } {
    const offer: Joinable['offer'] = {};
    const entry: UndoEntry = {
        scope,
        label,
        undo: async () => {
            // Out of the way before anything it says about the undo.
            if (offer.key) toast.queue.close(offer.key);

            return undo();
        },
    };

    stack.push(entry);
    offer.key = offerUndo(stack, entry);

    return { entry, offer };
}

/**
 * Records a change that is not an edit of a task's fields (an archive, a restore) with its offer to undo. `undo` reverses it and resolves to whether it did; it says
 * itself why it could not, and `showUndone` when it did. The change is already made: a refused one records nothing.
 */
export function recordUndo(stack: UndoStack, scope: string, label: string, undo: () => Promise<boolean>): void {
    pushEntry(stack, scope, label, undo);
}

/**
 * Sends the commands like `sendEach` and, for the `task.update`s the daemon accepted, records one undo entry for the whole action and shows its toast.
 * A bulk change over a selection is one entry. Every change a person makes to a task goes through here (the keys, the drag, the panel), so recording is in one place.
 * The previous values are read before anything is sent. A refused change records nothing, and neither does anything but `task.update`: delete and start cannot be taken back.
 * At most one update per task, so each previous value is the one before this action.
 */
export async function sendWithUndo(
    root: RootStore,
    project: ProjectState,
    inputs: readonly CommandInput[],
    stack: UndoStack = undoStack
): Promise<CommandResult[]> {
    const pending = inputs.map(input =>
        input.type === 'task.update' ? changeOf(input, project.tasks.get(input.taskId)) : null
    );
    const results = await sendEach(root, inputs);
    const changes = pending.flatMap((change, index) => (change && results[index]?.ok ? [change] : []));

    if (changes.length > 0) record(root, project, stack, changes);

    return results;
}
