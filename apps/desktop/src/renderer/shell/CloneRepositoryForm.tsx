import { Button } from '@clowdy/components/Button';
import { FormField } from '@clowdy/components/FormField';
import { Input } from '@clowdy/components/Input';
import { Modal, useModalContext } from '@clowdy/components/Modal';
import { Spinner } from '@clowdy/components/Spinner';
import { Text } from '@clowdy/components/Text';
import { type FormEvent, type RefObject, useEffect, useRef, useState } from 'react';

import { TransportError } from '../daemon/transport';
import { tildePath } from '../shared/displayPath';
import { homeFolder } from '../shared/homeFolder';
import styles from './CloneRepositoryForm.module.css';

import type { GitCloneTarget } from '@clowdy/protocol';
import type { GitCloneProgress, Transport } from '../daemon/transport';

export interface CloneRepositoryProps {
    transport: Transport;
    /** Called with the folder the clone made, once it is there: the list the dialog was opened from adds it like a folder the person picked. */
    onAdd: (paths: string[]) => void;
}

/**
 * "Clone repository…": a small window over whatever opened it, the Add project form or Settings, which stays where it is behind it. No `title` option: the heading is drawn in the form, as
 * `openAddProject` does, and the window's own close button floats at the corner. It takes no `RootStore`: a window made by `Modal.create` has no React context, so the daemon is passed in.
 */
export function openCloneRepository(props: CloneRepositoryProps): void {
    Modal.create({
        width: 460,
        shadow: true,
        clickOut: true,
        closeOnEscape: true,
        closeButton: true,
        handle: false,
        component: <CloneRepositoryForm {...props} />,
    });
}

/** How long the address and the folder rest before the daemon is asked where the clone would go. */
const TARGET_DELAY_MS = 250;

/** What the daemon answered for an address and a folder, and for which: an answer for an older pair is not shown as the answer for this one. */
interface TargetAnswer {
    key: string;
    /** The folder was one the person chose, not the projects folder: the words of the answer depend on it. */
    chosen: boolean;
    target?: GitCloneTarget;
    error?: string;
}

/** What a clone that stopped says: git's line, and the hint the daemon added to it. */
interface Failure {
    message: string;
    hint?: string;
}

/** A failure belongs to the address and the folder it came with: once either changes it no longer describes them, and it goes. */
interface KeptFailure extends Failure {
    inputs: string;
}

const reasonOf = (error: unknown): Failure => ({
    message: error instanceof Error && error.message ? error.message : "Couldn't clone the repository",
    ...(error instanceof TransportError && error.hint && { hint: error.hint }),
});

const isAbort = (error: unknown): boolean => error instanceof DOMException && error.name === 'AbortError';

/** A path without the separators at its end, and on Windows (a drive letter) without the difference of letter case: two paths of one folder compare equal. */
function comparable(path: string): string {
    const bare = /^([a-z]:)?[\\/]+$/i.test(path) ? path : path.replace(/[\\/]+$/, '');

    return /^[a-z]:/i.test(bare) ? bare.toLowerCase() : bare;
}

/** The folder the repository lands in, split for the line that shows it: the part the person already has, and the last name when the repository gets a folder of its own. */
export function targetParts(target: GitCloneTarget & { path: string }): {
    head: string;
    name: string;
    inside: boolean;
} {
    const path = tildePath(target.path, homeFolder.path);
    const inside = comparable(target.path) !== comparable(target.folder);
    const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));

    return inside && cut >= 0
        ? { head: path.slice(0, cut + 1), name: path.slice(cut + 1), inside }
        : { head: '', name: path, inside };
}

/**
 * "Clone repository…": an address, the folder it goes to, and the whole path the repository will end up in, which the dialog asks the daemon for as the address and the folder change
 * (`getGitCloneTarget`) and never guesses: a folder that is empty or new becomes the repository itself, a folder that holds files gets the repository in a folder of its own inside,
 * and the line says which. Clone shows git's progress and can be cancelled; a dialog that closes meanwhile (the window's button, Escape, a click outside) cancels it too. A clone that
 * stops on an error leaves the dialog open and editable.
 */
export function CloneRepositoryForm({ transport, onAdd }: CloneRepositoryProps) {
    const { modal } = useModalContext();
    const [url, setUrl] = useState('');
    const [folder, setFolder] = useState('');
    const [answer, setAnswer] = useState<TargetAnswer>();
    // The projects folder as the daemon last named it, which says where an unchosen folder is while the address changes.
    const [known, setKnown] = useState<string>();
    // Bumped when a clone failed, so the daemon is asked again where it would go: what it said before the clone may be out of date.
    const [refresh, setRefresh] = useState(0);
    const [progress, setProgress] = useState<GitCloneProgress>();
    const [isCloning, setIsCloning] = useState(false);
    const [kept, setKept] = useState<KeptFailure>();
    const running = useRef<AbortController>(null);
    const asked = useRef<string>(undefined);
    const wasCloning = useRef(false);
    const form = useRef<HTMLFormElement>(null);
    const cancelButton = useRef<HTMLButtonElement | HTMLAnchorElement | null>(null);
    const chooseButton = useRef<HTMLButtonElement | HTMLAnchorElement | null>(null);
    const choose = window.desktop?.chooseDirectories;
    const address = url.trim();
    const chosen = folder.trim();
    const inputs = `${address}\n${chosen}`;
    const key = `${inputs}\n${refresh}`;
    // What the card shows is the daemon's latest answer, dimmed while it is for an older address or folder; only an answer for these ones can be cloned to.
    const current = answer?.key === key ? answer : undefined;
    const path = current?.target?.path;
    const canClone = path !== undefined && !current?.target?.blocked && !isCloning;
    const failure = kept?.inputs === inputs ? kept : undefined;

    // Where the clone would go for this address and folder. A newer pair drops the request of the older one, whatever it answers.
    useEffect(() => {
        const controller = new AbortController();
        const ask = () =>
            transport.getGitCloneTarget(address, chosen || undefined, controller.signal).then(
                found => {
                    if (controller.signal.aborted) return;

                    setAnswer({ key, chosen: chosen !== '', target: found });

                    if (!chosen) setKnown(found.folder);
                },
                (error: unknown) => {
                    if (!controller.signal.aborted)
                        setAnswer({ key, chosen: chosen !== '', error: reasonOf(error).message });
                }
            );
        // The first answer names the projects folder, which the form shows before anything is typed, and one asked again for the same address and folder is not waited for either.
        const timer = setTimeout(ask, asked.current === undefined || asked.current === inputs ? 0 : TARGET_DELAY_MS);

        asked.current = inputs;

        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [transport, key, inputs, address, chosen]);

    // Whatever closes the dialog while a clone runs cancels it, and the daemon removes what it made.
    useEffect(() => () => running.current?.abort(), []);

    // The window closes on Escape only while the focus is inside it, and a control that is disabled or gone drops the focus to the page: Cancel takes it while a clone runs,
    // and the address takes it back when the clone stops.
    useEffect(() => {
        if (isCloning) cancelButton.current?.focus();
        else if (wasCloning.current) form.current?.querySelector('input')?.focus();

        wasCloning.current = isCloning;
    }, [isCloning]);

    const clone = async () => {
        if (!canClone || !path) return;

        const controller = new AbortController();

        running.current = controller;
        setIsCloning(true);
        setKept(undefined);
        setProgress(undefined);

        try {
            const made = await transport.cloneGit({ url: address, path }, setProgress, controller.signal);

            if (controller.signal.aborted) return;

            onAdd([made]);
            modal.cancel();
        } catch (error) {
            if (controller.signal.aborted || isAbort(error)) return;

            setKept({ inputs, ...reasonOf(error) });
            setRefresh(count => count + 1);
        } finally {
            if (running.current === controller) {
                running.current = null;
                setIsCloning(false);
                setProgress(undefined);
            }
        }
    };

    const cancel = () => running.current?.abort();

    const submit = (event: FormEvent) => {
        event.preventDefault();
        void clone();
    };

    // A dialog that fails to open is a dialog that was closed: the folder stays as it was. A repository goes to one folder, and the dialog may hand back several.
    const pick = () =>
        void choose?.().then(
            ([picked, ...more]) => {
                if (more.length > 0) setKept({ inputs, message: 'Choose one folder' });
                else if (picked) setFolder(picked);
            },
            () => undefined
        );

    return (
        <form ref={form} className={styles.form} onSubmit={submit}>
            <Text variant="heading-3">Clone repository</Text>

            <FormField layout="vertical">
                <FormField.Label>Address</FormField.Label>
                <Input
                    type="text"
                    aria-label="Repository address"
                    value={url}
                    onChange={setUrl}
                    placeholder="https://github.com/owner/repo.git"
                    isDisabled={isCloning}
                    autoFocus
                />
            </FormField>

            <FolderChoice
                chosen={chosen}
                typed={folder}
                shown={known}
                isLocked={isCloning}
                onPick={choose ? pick : undefined}
                onType={setFolder}
                onReset={() => {
                    setFolder('');
                    // The button that said so is gone with the folder: the focus goes where the folder is chosen.
                    chooseButton.current?.focus();
                }}
                chooseRef={chooseButton}
            />

            <SaveTo answer={answer} isStale={current === undefined} />

            {failure && (
                <div className={styles.failure} role="alert">
                    <Text color="danger">{failure.message}</Text>
                    {failure.hint && (
                        <Text variant="sm" color="secondary">
                            {failure.hint}
                        </Text>
                    )}
                </div>
            )}

            {isCloning && <CloneProgress progress={progress} />}

            <div className={styles.actions}>
                {isCloning && (
                    <Button ref={cancelButton} type="button" variant="bordered" onPress={cancel}>
                        Cancel
                    </Button>
                )}
                {/* No Cancel while it waits for an address: the window's close button, Escape and a click outside already close it. */}
                <Button type="submit" color="primary" fullWidth isDisabled={!canClone} isPending={isCloning}>
                    Clone
                </Button>
            </div>
        </form>
    );
}

interface FolderChoiceProps {
    /** The folder the person chose or typed, without the spaces around it; empty for the daemon's projects folder. */
    chosen: string;
    /** What is in the folder field as it was typed: a space at its end is a space the person is still typing past. */
    typed: string;
    /** The projects folder as the daemon last named it. */
    shown: string | undefined;
    isLocked: boolean;
    /** Opens the system dialog; absent in a plain browser, which has a field instead. */
    onPick?: () => void;
    onType: (folder: string) => void;
    onReset: () => void;
    chooseRef: RefObject<HTMLButtonElement | HTMLAnchorElement | null>;
}

/**
 * The folder the repository goes to, which the person may choose: with the system dialog in the desktop app, in a field in a plain browser. With none chosen it is the
 * projects folder, which the line says in so many words.
 */
function FolderChoice({ chosen, typed, shown, isLocked, onPick, onType, onReset, chooseRef }: FolderChoiceProps) {
    const where = chosen || shown;

    if (!onPick) {
        return (
            <FormField layout="vertical">
                <FormField.Label>Folder</FormField.Label>
                <FormField.Description>Left empty, the Clowdy projects folder is used</FormField.Description>
                <Input
                    type="text"
                    aria-label="Folder"
                    value={typed}
                    onChange={onType}
                    placeholder={shown ? tildePath(shown, homeFolder.path) : '/Users/you/code'}
                    isDisabled={isLocked}
                />
            </FormField>
        );
    }

    return (
        <div className={styles.field}>
            <Text variant="heading-5">Folder</Text>
            <div className={styles.folder}>
                <div className={styles.where}>
                    <Text variant="sm" color="secondary">
                        {chosen ? 'The folder you chose' : 'Clowdy projects folder'}
                    </Text>
                    {where ? (
                        <Text variant="sm" className={styles.value} title={where}>
                            {tildePath(where, homeFolder.path)}
                        </Text>
                    ) : (
                        <Text variant="sm" color="secondary">
                            …
                        </Text>
                    )}
                </div>
                <div className={styles.buttons}>
                    {chosen && (
                        <Button variant="ghost" size="sm" isDisabled={isLocked} onPress={onReset}>
                            Use projects folder
                        </Button>
                    )}
                    <Button ref={chooseRef} variant="bordered" size="sm" isDisabled={isLocked} onPress={onPick}>
                        Choose folder…
                    </Button>
                </div>
            </div>
        </div>
    );
}

interface SaveToProps {
    /** The daemon's latest answer, which may be for an older address or folder (`isStale`); nothing before the first one. */
    answer?: TargetAnswer;
    /** The address or the folder changed and the daemon has not answered yet: what shows is the answer to the one before. */
    isStale: boolean;
}

/**
 * The whole path the repository will be cloned into, and in words which of the two cases it is: the folder itself, or a new folder inside it. The path is written in full (the home folder as
 * `~`, never shortened in the middle): it is what the person decides by. The projects folder is where repositories go, so a repository there always gets a folder of its own, and the words
 * do not claim the folder has files, which the daemon did not say. A refused target says why in the danger colour, with the path when there is one.
 */
function SaveTo({ answer, isStale }: SaveToProps) {
    const target = answer?.target;
    const path = target?.path;
    const parts = target && path ? targetParts({ ...target, path }) : undefined;
    const subject = answer?.chosen ? 'The folder' : 'The projects folder';

    return (
        <div className={styles.target} aria-live="polite" aria-busy={isStale} data-stale={isStale || undefined}>
            <Text variant="heading-5">Save to</Text>
            {answer?.error ? (
                <Text variant="sm" color="danger">
                    {answer.error}
                </Text>
            ) : (
                <>
                    {parts && (
                        <Text className={styles.path} title={path}>
                            <span className={styles.head}>{parts.head}</span>
                            <span className={styles.name} data-inside={parts.inside || undefined}>
                                {parts.name}
                            </span>
                        </Text>
                    )}
                    {target?.blocked ? (
                        <Text variant="sm" color="danger">
                            {target.blocked}
                        </Text>
                    ) : parts?.inside ? (
                        <Text variant="sm" color="secondary">
                            {answer?.chosen ? 'The folder has files, so a folder named ' : 'A folder named '}
                            <Text variant="sm" bold>
                                {parts.name}
                            </Text>
                            {answer?.chosen ? ' will be made inside it' : ' will be made in the projects folder'}
                        </Text>
                    ) : parts ? (
                        <Text variant="sm" color="secondary">
                            {`${subject} is empty or new, so the repository will be the folder itself`}
                        </Text>
                    ) : (
                        <Text variant="sm" color="secondary">
                            Enter a repository address to see where it will be saved
                        </Text>
                    )}
                </>
            )}
        </div>
    );
}

/** What git is doing now: its own line and percent over a bar, or the line with a spinner while it gives no percent. */
function CloneProgress({ progress }: { progress?: GitCloneProgress }) {
    const percent =
        progress?.percent === undefined ? undefined : Math.min(100, Math.max(0, Math.round(progress.percent)));

    return (
        <div className={styles.progress}>
            <div className={styles.details}>
                {percent === undefined && <Spinner size="xs" />}
                <Text variant="sm" truncate className={styles.label}>
                    {progress?.label ?? 'Starting the clone'}
                </Text>
                {percent !== undefined && (
                    <Text variant="sm" color="secondary" className={styles.figure}>
                        {`${percent}%`}
                    </Text>
                )}
            </div>
            {percent !== undefined && (
                <div
                    className={styles.track}
                    role="progressbar"
                    aria-label={progress?.label}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent}
                    aria-valuetext={`${percent}%`}
                >
                    <div className={styles.fill} style={{ width: `${percent}%` }} />
                </div>
            )}
        </div>
    );
}
