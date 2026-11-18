import { Button } from '@clowdy/components/Button';
import { For } from '@clowdy/components/For';
import { ListBox, ListBoxHeader, ListBoxItem, ListBoxSection } from '@clowdy/components/List';
import { OverlayTriggerStateContext, Popover, PopoverTrigger } from '@clowdy/components/Popover';
import { Scrollable } from '@clowdy/components/Scrollable';
import { Show } from '@clowdy/components/Show';
import { Spinner } from '@clowdy/components/Spinner';
import { Text } from '@clowdy/components/Text';
import { ChevronDown } from '@clowdy/icons/10';
import { Check, ChevronLeft } from '@clowdy/icons/14';
import { cn } from '@clowdy/lib';
import { use, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';

import { ProviderIcon } from '../settings/providers/ProviderIcon';
import styles from './ModelPicker.module.css';
import { choiceForModel, defaultEffort, levelLabel, pickableModels, readRemembered, type ModelChoice } from './modelSelection';
import { ReasoningSlider } from './ReasoningSlider';

import type { AgentModel } from '@clowdy/protocol';
import type { AgentModelList } from '../../stores';

/** One provider the list offers: its id, its name for a section header, and the models it lists (read when the popover first opens). */
export interface PickerProvider {
    id: string;
    name: string;
    list: AgentModelList;
}

export interface ModelPickerProps {
    /** What the picker holds. Without one there is nothing to show. */
    choice: ModelChoice | undefined;
    /** The providers the list offers, in order. More than one makes sections; a chat that has started has the one it runs on. */
    providers: readonly PickerProvider[];
    /** The orchestrator is working: a pick applies from its next message, and the popover says so. */
    running?: boolean;
    /** The person picked a model (with the level it starts on) or moved the slider (the same model and provider, another level). */
    onPick: (choice: ModelChoice) => void;
}

/** What the picker knows of the choice it holds, from the lists of the providers. */
interface Held {
    provider: PickerProvider | undefined;
    /** The provider's entry for the model, when it lists it. */
    model: AgentModel | undefined;
    /** The model's name, else its id as it was stored, else what stands in until there is one. */
    title: string;
    /** The levels the model offers: none, one (shown as text) or several (a slider). */
    levels: readonly string[];
    /** The level in force: the one chosen if the model offers it, else the model's own default. Nothing for a model with no levels. */
    level: string | undefined;
    /** The provider's list has not answered yet. */
    loading: boolean;
    /** The list was read and has no such model: a retired or older id. */
    missing: boolean;
}

function holdOf(choice: ModelChoice, providers: readonly PickerProvider[]): Held {
    const provider = providers.find(candidate => candidate.id === choice.engine);
    const answer = provider?.list.models;
    const model = answer?.models.find(candidate => candidate.id === choice.model);
    const loading = provider !== undefined && answer === undefined && (provider.list.status === 'idle' || provider.list.status === 'loading');
    const levels = model?.efforts ?? [];
    const level = model && levels.length > 0 ? (choice.effort !== undefined && levels.includes(choice.effort) ? choice.effort : defaultEffort(model)) : undefined;
    const title = model?.name ?? choice.model ?? (loading ? 'Model' : provider?.name ?? 'Model');

    return { provider, model, title, levels, level, loading, missing: choice.model !== undefined && answer?.state === 'ok' && model === undefined };
}

/** The key of a row: models of two providers may share an id (Claude Code's `default`, Cursor's `default`). */
const rowKey = (engine: string, model: string) => `${ engine }:${ model }`;

/** The rows a provider offers, once its list has been read. */
function rowsOf(provider: PickerProvider): AgentModel[] {
    const answer = provider.list.models;

    return answer?.state === 'ok' ? pickableModels(answer.models) : [];
}

/** What a provider says in the list instead of rows, or on top of stale ones: it is being read, or why it gives none. */
function noteOf(provider: PickerProvider): { busy: true } | { busy: false; text: string } | undefined {
    const { list, name } = provider;
    const answer = list.models;

    if (list.status === 'failed') return { busy: false, text: `The models could not be read. ${ list.error }`.trim() };

    if (!answer) return { busy: true };

    if (answer.state !== 'ok') return { busy: false, text: answer.detail ?? `${ name } cannot list its models.` };

    return answer.models.length === 0 ? { busy: false, text: `${ name } lists no models.` } : undefined;
}

function Trigger({ choice, providers }: { choice: ModelChoice; providers: readonly PickerProvider[] }) {
    const isOpen = use(OverlayTriggerStateContext)!.isOpen;
    const held = holdOf(choice, providers);
    const label = held.level ? `${ held.title } · ${ levelLabel(held.level) }` : held.title;

    return (
        <Button
            size="sm"
            variant="filling"
            rounded
            className={ styles.trigger }
            contentClassName={ styles.triggerContent }
            data-open={ isOpen || undefined }
            aria-label={ `Model: ${ label }` }
        >
            <ProviderIcon agentId={ choice.engine } size={ 16 } aria-hidden="true" />
            <span className={ styles.modelLabel }>
                <Text truncate>{ held.title }</Text>
                <Show when={ held.level }>
                    { level => <span className={ styles.level }>{ levelLabel(level) }</span> }
                </Show>
            </span>
            <Show when={ held.loading }>
                <Spinner size="xs" />
            </Show>
            <ChevronDown aria-hidden="true" />
        </Button>
    );
}

/**
 * The popover keeps the trigger's rectangle for as long as it is open: the label changes width as a model is chosen, and an anchor that
 * moved would make it jump. A press that lands in a list is the list's own, not an outside press.
 */
function FrozenPopover({ children }: { children: ReactNode }) {
    const isOpen = use(OverlayTriggerStateContext)!.isOpen;
    const frozen = useRef<DOMRect | null>(null);

    useEffect(() => {
        if (!isOpen) frozen.current = null;
    }, [isOpen]);

    return (
        <Popover
            className={ styles.popover }
            placement="top"
            spacing="none"
            width={ 320 }
            aria-label="Model and reasoning effort"
            shouldCloseOnInteractOutside={ target => !(target instanceof Element && target.closest('[role="listbox"]')) }
            getTargetRect={ (target) => {
                frozen.current ??= target.getBoundingClientRect();

                return frozen.current;
            } }
        >
            { children }
        </Popover>
    );
}

interface FaceProps {
    choice: ModelChoice;
    held: Held;
    running: boolean;
    buttonRef: RefObject<HTMLButtonElement | HTMLAnchorElement | null>;
    onOpenList: () => void;
    onLevel: (level: string) => void;
}

/** The first pane: the model as a big button that opens the list, and the reasoning effort of that model. */
function Face({ choice, held, running, buttonRef, onOpenList, onLevel }: FaceProps) {
    return (
        <div className={ styles.face }>
            <Button ref={ buttonRef } variant="filling" color="secondary" size="md" className={ styles.modelButton } aria-label="Select model" onPress={ onOpenList }>
                <ProviderIcon agentId={ choice.engine } size={ 16 } aria-hidden="true" />
                <span className={ styles.modelLabel }>
                    <span className={ styles.modelTitle }>{ held.title }</span>
                    <Show when={ held.level }>
                        { level => <span className={ styles.level }>{ levelLabel(level) }</span> }
                    </Show>
                </span>
                <ChevronDown aria-hidden="true" />
            </Button>

            <div className={ styles.reasoning }>
                { /* The level is there for a model with levels: a slider to move along them, or its only one as text. */ }
                <Show when={ held.level }>
                    { level => (
                        <>
                            <Text variant="label" color="secondary">Reasoning effort</Text>
                            { held.levels.length > 1
                                ? <ReasoningSlider levels={ held.levels } value={ level } onChange={ onLevel } />
                                : <Text className={ styles.faceText }>{ levelLabel(level) }</Text> }
                        </>
                    ) }
                </Show>

                <Show when={ held.levels.length === 0 ? (held.model?.description ?? (held.missing ? `${ held.provider?.name ?? 'The provider' } does not list this model anymore.` : '')) : undefined }>
                    { text => <Text className={ styles.faceText }>{ text }</Text> }
                </Show>

                <Show when={ running }>
                    <Text className={ styles.footnote }>Applies from the next message</Text>
                </Show>
            </div>
        </div>
    );
}

interface ListProps {
    choice: ModelChoice;
    providers: readonly PickerProvider[];
    onBack: () => void;
    onPickModel: (provider: PickerProvider, model: AgentModel) => void;
}

/** The second pane: the models, in a section for each provider when there are several, then what the providers that gave none say. */
function ModelList({ choice, providers, onBack, onPickModel }: ListProps) {
    const groups = providers.map(provider => ({ provider, rows: rowsOf(provider) })).filter(group => group.rows.length > 0);
    const notes = providers.flatMap((provider) => {
        const note = noteOf(provider);

        return note ? [{ provider, note }] : [];
    });
    const sectioned = providers.length > 1;
    const flat = groups[0];
    const byKey = new Map(groups.flatMap(({ provider, rows }) => rows.map(model => [rowKey(provider.id, model.id), { provider, model }] as const)));
    const selected = choice.model === undefined ? undefined : rowKey(choice.engine, choice.model);

    const pickKey = (key: unknown) => {
        const row = typeof key === 'string' ? byKey.get(key) : undefined;

        if (row) onPickModel(row.provider, row.model);
    };

    const renderRow = (provider: PickerProvider, model: AgentModel) => {
        const key = rowKey(provider.id, model.id);

        return (
            <ListBoxItem
                key={ key }
                id={ key }
                data-model-id={ model.id }
                data-engine={ provider.id }
                text={ model.name }
                icon={ <ProviderIcon agentId={ provider.id } size={ 16 } aria-hidden="true" /> }
                endAffix={ key === selected ? <Check aria-hidden="true" /> : undefined }
                // A press on a row picks it as the pointer lets go, before the popover can read the press as one outside it.
                onPointerUp={ () => pickKey(key) }
            />
        );
    };

    return (
        <div className={ styles.models }>
            <span className={ styles.listHead }>
                <Button size="sm" iconOnly variant="filling" color="secondary" aria-label="Back" onPress={ onBack }>
                    <ChevronLeft aria-hidden="true" />
                </Button>
                <Text className={ styles.listTitle }>Select model</Text>
            </span>

            <Scrollable className={ styles.modelScroll }>
                <Show when={ groups.length > 0 }>
                    <ListBox
                        className={ styles.modelList }
                        aria-label="Model"
                        size="sm"
                        selectionMode="single"
                        disallowEmptySelection
                        selectedKeys={ selected !== undefined && byKey.has(selected) ? [selected] : [] }
                        onSelectionChange={ (keys) => {
                            if (keys !== 'all') pickKey([...keys][0]);
                        } }
                    >
                        <Show when={ sectioned } fallback={ flat && <For each={ flat.rows }>{ model => renderRow(flat.provider, model) }</For> }>
                            <For each={ groups }>
                                { ({ provider, rows }) => (
                                    <ListBoxSection key={ provider.id } id={ provider.id }>
                                        <ListBoxHeader>{ provider.name }</ListBoxHeader>
                                        <For each={ rows }>{ model => renderRow(provider, model) }</For>
                                    </ListBoxSection>
                                ) }
                            </For>
                        </Show>
                    </ListBox>
                </Show>

                <For each={ notes }>
                    { ({ provider, note }) => (
                        <div key={ provider.id } className={ styles.note } data-provider={ provider.id }>
                            <Show when={ sectioned }>
                                <span className={ styles.noteTitle }>{ provider.name }</span>
                            </Show>
                            { note.busy
                                ? (
                                    <span className={ styles.noteBusy }>
                                        <Spinner size="xs" />
                                        <Text className={ styles.noteText }>Reading the models…</Text>
                                    </span>
                                )
                                : (
                                    <>
                                        <Text className={ styles.noteText }>{ note.text }</Text>
                                        <Button size="xs" variant="bordered" onPress={ () => void provider.list.reload() }>Retry</Button>
                                    </>
                                ) }
                        </div>
                    ) }
                </For>
            </Scrollable>
        </div>
    );
}

interface PanelProps {
    choice: ModelChoice;
    providers: readonly PickerProvider[];
    running: boolean;
    onPick: (choice: ModelChoice) => void;
}

/** The two panes on their stage. It exists only while the popover is open, so every opening starts on the face. */
function ModelPanel({ choice, providers, running, onPick }: PanelProps) {
    const [picking, setPicking] = useState(false);
    const [height, setHeight] = useState<number | null>(null);
    const [animate, setAnimate] = useState(false);
    const faceLayer = useRef<HTMLDivElement>(null);
    const listLayer = useRef<HTMLDivElement>(null);
    const modelButton = useRef<HTMLButtonElement | HTMLAnchorElement | null>(null);
    // A pick can arrive twice, from the press and from the selection it makes: the second is the same gesture.
    const settled = useRef(false);
    const wasPicking = useRef(false);
    const held = holdOf(choice, providers);

    // The lists are read when the popover opens, for the providers that have not been asked yet. A failed one waits for its Retry.
    useEffect(() => {
        for (const provider of providers) {
            if (provider.list.status === 'idle') void provider.list.load();
        }
    }, [providers]);

    // The stage is as tall as the active pane, and follows it as it changes.
    useLayoutEffect(() => {
        const target = picking ? listLayer.current : faceLayer.current;

        if (!target) return;

        const measure = () => {
            const next = target.offsetHeight;

            if (next > 0) setHeight(current => (current === next ? current : next));
        };

        measure();

        if (typeof ResizeObserver === 'undefined') return;

        const observer = new ResizeObserver(measure);

        observer.observe(target);

        return () => observer.disconnect();
    }, [picking]);

    // Only changes after the first measurement are animated.
    useEffect(() => {
        if (height !== null) setAnimate(true);
    }, [height]);

    // The list takes the focus when it opens, on the model in force; the face takes it back (on the model button) when the list closes.
    useEffect(() => {
        if (picking === wasPicking.current) return;

        wasPicking.current = picking;

        if (picking) {
            const pane = listLayer.current;

            (pane?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]') ?? pane?.querySelector<HTMLElement>('[role="listbox"]') ?? pane?.querySelector<HTMLElement>('button'))?.focus();
        }
        else {
            modelButton.current?.focus();
        }
    }, [picking]);

    const openList = () => {
        settled.current = false;
        setPicking(true);
    };

    const pickModel = (provider: PickerProvider, model: AgentModel) => {
        if (settled.current) return;

        settled.current = true;

        // The model in force just goes back to the face; any other is a pick, with the level it takes there.
        if (provider.id !== choice.engine || model.id !== choice.model) onPick(choiceForModel(provider.id, model, choice.effort, readRemembered()));

        setPicking(false);
    };

    // Escape in the list goes back to the face first; on the face it closes the popover, as ever. Enter or Space on the model in force
    // does the same: the listbox reports no change when its selected row is chosen again, so nothing else would answer the key. It is
    // read in the capture phase because a row's press handling stops its own Enter and Space before they bubble.
    const onListKeyDown = (event: KeyboardEvent) => {
        const inForce = (event.key === 'Enter' || event.key === ' ') && event.target instanceof Element && event.target.closest('[role="option"][aria-selected="true"]') !== null;

        if (event.key !== 'Escape' && !inForce) return;

        event.preventDefault();
        event.stopPropagation();
        setPicking(false);
    };

    return (
        <div className={ styles.stage } data-measured={ height === null ? undefined : true } data-animate={ animate ? true : undefined } style={ height === null ? undefined : { height } }>
            <div ref={ faceLayer } className={ cn(styles.layer, styles.faceLayer) } data-hidden={ picking || undefined } inert={ picking || undefined }>
                <Face choice={ choice } held={ held } running={ running } buttonRef={ modelButton } onOpenList={ openList } onLevel={ level => onPick({ ...choice, effort: level }) } />
            </div>
            <div ref={ listLayer } className={ cn(styles.layer, styles.listLayer) } data-open={ picking || undefined } inert={ !picking || undefined } onKeyDownCapture={ onListKeyDown }>
                <ModelList choice={ choice } providers={ providers } onBack={ () => setPicking(false) } onPickModel={ pickModel } />
            </div>
        </div>
    );
}

/**
 * The model and reasoning picker of the composer: a pill with the provider's mark, the model and its level, that opens a popover with
 * the model as a big button over the reasoning slider, and the list of models in its place when that button is pressed. Picking a
 * row, or moving the slider, calls `onPick`; the pill shows what `choice` says, so the caller decides what a pick does.
 */
export function ModelPicker({ choice, providers, running = false, onPick }: ModelPickerProps) {
    if (!choice) return null;

    return (
        <PopoverTrigger>
            <Trigger choice={ choice } providers={ providers } />
            <FrozenPopover>
                <ModelPanel choice={ choice } providers={ providers } running={ running } onPick={ onPick } />
            </FrozenPopover>
        </PopoverTrigger>
    );
}

/** The pill of a composer with no provider to pick from: off, and the caller says why (see `Unavailable` in the composer). */
export function ModelPickerOff() {
    return (
        <Button size="sm" variant="filling" rounded isDisabled className={ styles.trigger } contentClassName={ styles.triggerContent } aria-label="No provider">
            <span className={ styles.modelLabel }>
                <Text truncate>No provider</Text>
            </span>
            <ChevronDown aria-hidden="true" />
        </Button>
    );
}
