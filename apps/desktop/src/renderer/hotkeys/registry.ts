import { makeAutoObservable, observableRef, observableShallow, runInAction } from 'mobx';
import { parseKeybinding } from 'tinykeys';

import type { KeybindingPress } from 'tinykeys';
import type { DesktopBridge } from '../../shared/bridge';

/** The operating system, as `window.desktop.platform` reports it. */
export type Platform = DesktopBridge['platform'];

/** `mac` keys serve macOS, `win` keys serve Windows and Linux. */
export type KeyFamily = 'mac' | 'win';

/**
 * Keys in tinykeys' grammar: `k`, `Shift+r`, `$mod+k` (Cmd on macOS, Ctrl elsewhere), `g c` (a sequence).
 * A press matches `KeyboardEvent.key` (`ArrowDown`, `Escape`, `Enter`) or `.code` (`Slash`, `Quote`), case-insensitively.
 * On a layout without Latin letters (Cyrillic, Greek) a letter also matches its physical key, so `g` works there too.
 * Modifiers are strict, except that a symbol key (`?`, `/`, `.`) also accepts Shift because many layouts type it that way.
 */
export type Keys = string | readonly string[];

/** Different keys per platform. */
export interface PlatformKeys {
    mac: Keys;
    /** Also serves Linux. */
    win: Keys;
}

export type CommandKeys = Keys | PlatformKeys;

/** A command: what the keys do, and the labels the shortcuts page and key hints show for it. */
export interface Command {
    /** Stable and unique, like `tasks.cursor.down`. */
    id: string;
    title: string;
    /** Group of the shortcuts page. */
    group: string;
    /** A string or a list of alternatives; the first is the one hints show. */
    keys: CommandKeys;
    /** The command is live while this scope is on the stack. `app` is always live. */
    scope: string;
    /**
     * Switches the command off while it returns false: it does not exist for the screen now (no task under the cursor, nothing to save).
     * A key hint is not shown for it. The shortcuts page lists every command the same way.
     */
    when?: () => boolean;
    /**
     * Whether the keyboard focus is where the command's keys belong, for a key that a widget has its own use for (the arrows in a text field's neighbour, a Select's type-ahead).
     * The dispatcher runs the command only while this and `when` agree, but the key hints ignore it: they say whether the command
     * exists on this screen, not where the focus is.
     */
    focus?: () => boolean;
    /** Also runs while a text field has focus (modifier chords, Escape). */
    inInputs?: boolean;
    /** Also runs while a dialog, menu or listbox is open. */
    inOverlays?: boolean;
    /** Runs again while the key is held. */
    repeat?: boolean;
    handler: (event: KeyboardEvent) => void;
}

/** A parsed key sequence of one command. */
export interface Sequence {
    text: string;
    presses: KeybindingPress[];
    /** Each press as key names for `hotkeysToSymbols`. */
    display: string[][];
}

/** A command with its keys parsed for both key families, so conflicts show up whichever platform the person develops on. */
export interface RegisteredCommand {
    command: Command;
    sequences: Record<KeyFamily, Sequence[]>;
}

/** A chord waiting for its next key, for the HUD. */
export interface PendingChord {
    /** The presses typed so far, as key names for `hotkeysToSymbols`. */
    typed: string[][];
    /** The live commands the next key continues or completes, with the presses they still need. */
    candidates: { command: Command; remaining: string[][] }[];
}

export interface KeyConflict {
    a: Command;
    b: Command;
    /** `duplicate`: the same keys. `prefix`: one sequence starts the other (`g` and `g c`). */
    kind: 'duplicate' | 'prefix';
    message: string;
}

const MODIFIERS = ['Shift', 'Meta', 'Alt', 'Control'];

/** Modifiers in the order a person reads them: Apple's (control, option, shift, command), and Windows' (control first). */
const MODIFIER_ORDER: Record<KeyFamily, string[]> = {
    mac: ['Control', 'Alt', 'Shift', 'Meta'],
    win: ['Control', 'Meta', 'Alt', 'Shift'],
};

const MODIFIER_NAMES: Record<string, string> = { Shift: 'shift', Meta: 'meta', Alt: 'alt', Control: 'ctrl' };

const KEY_NAMES: Record<string, string> = {
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
    Escape: 'escape',
    Enter: 'enter',
    Backspace: 'backspace',
    Delete: 'delete',
    Space: 'space',
    Slash: '/',
    Period: '.',
    Comma: ',',
    Quote: "'",
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    Semicolon: ';',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
};

const familyOf = (platform: Platform): KeyFamily => (platform === 'darwin' ? 'mac' : 'win');

function detectPlatform(): Platform {
    if (typeof window !== 'undefined' && window.desktop?.platform) return window.desktop.platform;

    const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent;

    if (agent.includes('Mac')) return 'darwin';

    return agent.includes('Windows') ? 'win32' : 'linux';
}

/** A key in the vocabulary of `hotkeysToSymbols` (`ArrowDown` is `down`, `KeyK` is `k`, `Slash` is `/`). */
function keyName(key: string | RegExp): string {
    if (typeof key !== 'string') return `(${key.source})`;

    if (Object.hasOwn(KEY_NAMES, key)) return KEY_NAMES[key];

    const code = /^(?:Key([A-Z])|Digit(\d))$/.exec(key);

    return (code?.[1] ?? code?.[2] ?? key).toLowerCase();
}

const isSymbolKey = (key: string | RegExp): boolean => typeof key === 'string' && /^[^\p{L}\p{N}\s]$/u.test(key);

function parseSequence(text: string, family: KeyFamily): Sequence {
    const normalized = text.trim().split(/\s+/).join(' ');

    if (!normalized) throw new Error('keys cannot be empty');

    const presses = parseKeybinding(normalized.replaceAll('$mod', family === 'mac' ? 'Meta' : 'Control')).map(
        ([required, optional, key]): KeybindingPress => {
            const unknown = [...required, ...optional].find(modifier => !MODIFIERS.includes(modifier));

            if (unknown)
                throw new Error(`unknown modifier "${unknown}" in "${text}"; use $mod, Meta, Control, Alt or Shift`);

            // `?` is Shift+/ on US layouts and plain on others, so a symbol key takes Shift unless the keys say otherwise.
            const shiftTolerant = isSymbolKey(key) && !required.includes('Shift') && !optional.includes('Shift');

            return [required, shiftTolerant ? [...optional, 'Shift'] : optional, key];
        }
    );

    const display = presses.map(([required, , key]) => [
        ...MODIFIER_ORDER[family]
            .filter(modifier => required.includes(modifier))
            .map(modifier => MODIFIER_NAMES[modifier]),
        keyName(key),
    ]);

    return { text: normalized, presses, display };
}

function sequencesOf(keys: CommandKeys, family: KeyFamily): Sequence[] {
    const own = typeof keys === 'object' && 'mac' in keys ? keys[family] : (keys as Keys);

    return (typeof own === 'string' ? [own] : own).map(text => parseSequence(text, family));
}

function createEntry(command: Command): RegisteredCommand {
    try {
        return { command, sequences: { mac: sequencesOf(command.keys, 'mac'), win: sequencesOf(command.keys, 'win') } };
    } catch (error) {
        throw new Error(`Hotkey command "${command.id}": ${error instanceof Error ? error.message : String(error)}`, {
            cause: error,
        });
    }
}

/** Whether some key event can match both presses. */
function pressesOverlap(a: KeybindingPress, b: KeybindingPress): boolean {
    if (keyName(a[2]) !== keyName(b[2])) return false;

    const allows = (needs: KeybindingPress, has: KeybindingPress) =>
        needs[0].every(modifier => has[0].includes(modifier) || has[1].includes(modifier));

    return allows(a, b) && allows(b, a);
}

function sequencesCollide(a: Sequence, b: Sequence): KeyConflict['kind'] | null {
    const shared = Math.min(a.presses.length, b.presses.length);

    for (let index = 0; index < shared; index++) {
        if (!pressesOverlap(a.presses[index], b.presses[index])) return null;
    }

    return a.presses.length === b.presses.length ? 'duplicate' : 'prefix';
}

function conflictBetween(first: Command, a: Sequence, second: Command, b: Sequence): KeyConflict | null {
    const kind = sequencesCollide(a, b);

    if (!kind) return null;

    const how = kind === 'duplicate' ? 'uses the same keys as' : 'starts or continues the keys of';

    return { a: first, b: second, kind, message: `Hotkey "${first.id}" (${a.text}) ${how} "${second.id}" (${b.text})` };
}

/** Two commands can run on the same key press when they share a scope, or when one is in `app`, which is always live. */
const sharesScope = (a: Command, b: Command) => a.scope === b.scope || a.scope === 'app' || b.scope === 'app';

function entryConflict(first: RegisteredCommand, second: RegisteredCommand): KeyConflict | null {
    if (!sharesScope(first.command, second.command)) return null;

    for (const family of ['mac', 'win'] as const) {
        for (const a of first.sequences[family]) {
            for (const b of second.sequences[family]) {
                const conflict = conflictBetween(first.command, a, second.command, b);

                if (conflict) return conflict;
            }
        }
    }

    return null;
}

/** Two alternatives of one command that collide with each other. */
function ownConflict({ command, sequences }: RegisteredCommand): KeyConflict | null {
    for (const family of ['mac', 'win'] as const) {
        const list = sequences[family];

        for (let first = 0; first < list.length; first++) {
            for (let second = first + 1; second < list.length; second++) {
                const conflict = conflictBetween(command, list[first], command, list[second]);

                if (conflict) return conflict;
            }
        }
    }

    return null;
}

/**
 * Every collision in a set of commands: the same keys, or keys one of which starts the other, within one scope or against `app`.
 * Scopes of different sections never collide. Checks the keys of both platforms. A test can run the whole keymap through it.
 */
export function findKeyConflicts(commands: readonly Command[]): KeyConflict[] {
    const entries = commands.map(createEntry);
    const conflicts: KeyConflict[] = [];

    entries.forEach((entry, index) => {
        const own = ownConflict(entry);

        if (own) conflicts.push(own);

        for (const other of entries.slice(index + 1)) {
            const conflict = entryConflict(entry, other);

            if (conflict) conflicts.push(conflict);
        }
    });

    return conflicts;
}

/** Every way a command can be typed (`ArrowDown` and `j`), each as presses of key names for `hotkeysToSymbols`: `[['mod', 'k']]`, `[['g'], ['c']]`. */
export function commandSequences(command: Pick<Command, 'keys'>, platform: Platform = hotkeys.platform): string[][][] {
    return sequencesOf(command.keys, familyOf(platform)).map(sequence => sequence.display);
}

/** The presses of the command's first keys, for a key hint. The names are the ones `hotkeysToSymbols` understands. */
export function commandPresses(command: Pick<Command, 'keys'>, platform: Platform = hotkeys.platform): string[][] {
    return commandSequences(command, platform)[0] ?? [];
}

interface ScopeToken {
    name: string;
}

/** Holds the commands, the scope stack and the pending chord. The dispatcher reads it; React reads it through the hooks. */
export class HotkeyRegistry {
    readonly platform: Platform;
    readonly family: KeyFamily;
    /** Commands in definition order. */
    entries: RegisteredCommand[] = [];
    /** The chord waiting for its next key, or null. Written by the dispatcher. */
    pending: PendingChord | null = null;
    private scopeStack: ScopeToken[] = [];

    constructor(platform: Platform = detectPlatform()) {
        this.platform = platform;
        this.family = familyOf(platform);
        makeAutoObservable<HotkeyRegistry, 'scopeStack'>(this, {
            platform: false,
            family: false,
            entries: observableShallow,
            scopeStack: observableShallow,
            pending: observableRef,
            isLive: false,
            isEntryLive: false,
            scopeDepth: false,
            listCommands: false,
            findConflicts: false,
            assertNoConflicts: false,
        });
    }

    /** The active scopes, outermost first. `app` is always live and is not on the stack. */
    get scopes(): string[] {
        return this.scopeStack.map(token => token.name);
    }

    /**
     * Registers a command and returns the function that removes it.
     * Throws when its keys collide with another command's (see `findKeyConflicts`), when its keys cannot be parsed, or when the id is taken.
     */
    defineCommand(command: Command): () => void {
        if (this.entries.some(entry => entry.command.id === command.id))
            throw new Error(`Hotkey command "${command.id}" is already defined`);

        const entry = createEntry(command);
        const conflict = ownConflict(entry) ?? this.entries.map(other => entryConflict(entry, other)).find(Boolean);

        if (conflict) throw new Error(conflict.message);

        this.entries.push(entry);

        // The returned function runs from a React cleanup, outside any action, while a key hint may be observing `entries`.
        return () =>
            runInAction(() => {
                const index = this.entries.indexOf(entry);

                if (index >= 0) this.entries.splice(index, 1);
            });
    }

    /** Puts a scope on top of the stack, so its commands win over those of outer scopes. Returns the function that removes it. */
    pushScope(name: string): () => void {
        const token = { name };

        this.scopeStack.push(token);

        return () =>
            runInAction(() => {
                const index = this.scopeStack.indexOf(token);

                if (index >= 0) this.scopeStack.splice(index, 1);
            });
    }

    /** Set by the dispatcher while a chord waits for its next key. */
    setPending(pending: PendingChord | null) {
        this.pending = pending;
    }

    /** How deep the scope is on the stack: -1 for `app`, null when the scope is not active. A deeper scope wins. */
    scopeDepth(scope: string): number | null {
        if (scope === 'app') return -1;

        const index = this.scopeStack.findLastIndex(token => token.name === scope);

        return index >= 0 ? index : null;
    }

    /** Whether the command is defined, its scope is active and its `when` agrees. */
    isEntryLive(entry: RegisteredCommand): boolean {
        return (
            this.entries.includes(entry) &&
            this.scopeDepth(entry.command.scope) !== null &&
            (entry.command.when?.() ?? true)
        );
    }

    isLive(command: Command): boolean {
        const entry = this.entries.find(candidate => candidate.command === command);

        return entry !== undefined && this.isEntryLive(entry);
    }

    /** Every defined command, and those that are live now. */
    listCommands(): { live: Command[]; all: Command[] } {
        return {
            all: this.entries.map(entry => entry.command),
            live: this.entries.filter(entry => this.isEntryLive(entry)).map(entry => entry.command),
        };
    }

    findConflicts(): KeyConflict[] {
        return findKeyConflicts(this.entries.map(entry => entry.command));
    }

    /** For tests: throws when any two defined commands collide. */
    assertNoConflicts() {
        const conflicts = this.findConflicts();

        if (conflicts.length) throw new Error(conflicts.map(conflict => conflict.message).join('\n'));
    }
}

/** An isolated registry, for tests. The app uses `hotkeys`. */
export function createRegistry(platform?: Platform): HotkeyRegistry {
    return new HotkeyRegistry(platform);
}

/** The app's registry. A module singleton so content rendered by `Modal.create`, which has no React context, can read it. */
export const hotkeys = createRegistry();
