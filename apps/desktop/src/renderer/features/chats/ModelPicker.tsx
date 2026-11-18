import { Button } from '@clowdy/components/Button';
import { For } from '@clowdy/components/For';
import { ListBox, ListBoxItem } from '@clowdy/components/List';
import { OverlayTriggerStateContext, Popover, PopoverTrigger } from '@clowdy/components/Popover';
import { Scrollable } from '@clowdy/components/Scrollable';
import { Show } from '@clowdy/components/Show';
import { Spinner } from '@clowdy/components/Spinner';
import { Text } from '@clowdy/components/Text';
import { Tooltip } from '@clowdy/components/Tooltip';
import { ChevronDown } from '@clowdy/icons/10';
import { Check, ChevronLeft, ChevronRight } from '@clowdy/icons/14';
import { cn } from '@clowdy/lib';
import { use, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';

import { ProviderIcon } from '../settings/providers/ProviderIcon';
import styles from './ModelPicker.module.css';
import { choiceForModel, legalEffort, levelLabel, mainModels, modelRow, moreModels, pickableModels, readRemembered, type ModelChoice } from './modelSelection';
import { ReasoningSlider } from './ReasoningSlider';

import type { AgentModel } from '@clowdy/protocol';
import type { AgentModelList } from '../../stores';

/** One provider the list offers: its id, its name (for the strip's tooltip and the face's words), and the models it lists (read when the popover first opens). */
export interface PickerProvider {
    id: string;
    name: string;
    list: AgentModelList;
}

export interface ModelPickerProps {
    /** What the picker holds. Without one there is nothing to show. */
    choice: ModelChoice | undefined;
    /** The providers the list offers, in order. More than one makes a strip of their marks above the list; a chat that has started has the one it runs on. */
    providers: readonly PickerProvider[];
    /** The orchestrator is working: a pick applies from its next message, and the popover says so. */
    running?: boolean;
    /** The person picked a model (with the level it starts on) or moved the slider (the same model and provider, another level). */
    onPick: (choice: ModelChoice) => void;
}

/** What the picker knows of the choice it holds, from the lists of the providers. */
interface Held {
    provider: PickerProvider | undefined;
    /** The provider's row for the model, when it lists it: Claude's hidden `default` is the row of the model it stands for. */
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
    /** There is no model: the agent runs on its own default. */
    defaulted: boolean;
}

function holdOf(choice: ModelChoice, providers: readonly PickerProvider[]): Held {
    const provider = providers.find(candidate => candidate.id === choice.engine);
    const answer = provider?.list.models;
    const model = answer && choice.model !== undefined ? modelRow(answer.models, choice.model) : undefined;
    const loading = provider !== undefined && answer === undefined && (provider.list.status === 'idle' || provider.list.status === 'loading');
    const level = model ? legalEffort(model, choice.effort) : undefined;
    const title = model?.name ?? choice.model ?? (loading ? 'Model' : provider?.name ?? 'Model');

    return {
        provider,
        model,
        title,
        levels: model?.efforts ?? [],
        level,
        loading,
        missing: choice.model !== undefined && answer?.state === 'ok' && model === undefined,
        defaulted: choice.model === undefined && !loading,
    };
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

/** What lies outside the popover's own box and still belongs to it: a listbox (a press on a row) and the "More models" flyout, which is portalled. */
const OWN_LAYERS = '[role="listbox"], [data-model-flyout]';

/**
 * The popover keeps the trigger's rectangle for as long as it is open: the label changes width as a model is chosen, and an anchor that
 * moved would make it jump. A press (or focus) that lands in a list, or in the flyout of "More models", is the picker's own, not an outside press.
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
            shouldCloseOnInteractOutside={ target => !(target instanceof Element && target.closest(OWN_LAYERS)) }
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

/** What the face says under the model when it has no level to show: the agent's own default, the model's description, or that the model has gone. */
function faceNote(held: Held): string | undefined {
    if (held.levels.length > 0) return undefined;

    if (held.defaulted) return `Runs on ${ held.provider?.name ?? 'the provider' }'s own default until you pick a model.`;

    return held.model?.description ?? (held.missing ? `${ held.provider?.name ?? 'The provider' } does not list this model anymore.` : undefined);
}

/** The first pane: the model as a big button that opens the list, and under it what there is to say of the model's reasoning effort, if anything. */
function Face({ choice, held, running, buttonRef, onOpenList, onLevel }: FaceProps) {
    const note = faceNote(held);

    return (
        <div className={ styles.face }>
            <Button ref={ buttonRef } variant="filling" color="secondary" size="md" className={ styles.modelButton } aria-label="Select model" onPress={ onOpenList }>
                <ProviderIcon agentId={ choice.engine } size={ 16 } aria-hidden="true" />
                <span className={ styles.modelLabel }>
                    <span className={ styles.modelTitle }>{ held.defaulted ? 'Default model' : held.title }</span>
                    <Show when={ held.level }>
                        { level => <span className={ styles.level }>{ levelLabel(level) }</span> }
                    </Show>
                </span>
                <ChevronDown aria-hidden="true" />
            </Button>

            { /* Nothing to put here, no block: it would only add its padding to the face. */ }
            <Show when={ held.level !== undefined || Boolean(note) || running }>
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

                    <Show when={ note }>
                        { text => <Text className={ styles.faceText }>{ text }</Text> }
                    </Show>

                    <Show when={ running }>
                        <Text className={ styles.footnote }>Applies from the next message</Text>
                    </Show>
                </div>
            </Show>
        </div>
    );
}

interface StripProps {
    providers: readonly PickerProvider[];
    /** The provider whose models the list shows. */
    value: string;
    /** The list is in view. Its tabs have a tooltip only then: React Aria's tooltip wants a trigger that can be focused, and a pane out of view is `inert`. */
    active: boolean;
    onChange: (id: string) => void;
}

/**
 * The marks of the providers the list offers, as tabs: one is selected and the list shows its models. A tab picks nothing, it only turns
 * the list to another provider. The arrows, Home and End move between the tabs (and select the one they land on: a tab shows a list, which
 * is cheap to show), and only the selected tab is in the tab order.
 */
function ProviderStrip({ providers, value, active, onChange }: StripProps) {
    const strip = useRef<HTMLDivElement>(null);

    const onKeyDown = (event: KeyboardEvent) => {
        const last = providers.length - 1;
        const index = providers.findIndex(provider => provider.id === value);
        const next = event.key === 'ArrowRight' ? (index >= last ? 0 : index + 1) : event.key === 'ArrowLeft' ? (index <= 0 ? last : index - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? last : undefined;

        if (next === undefined) return;

        event.preventDefault();
        event.stopPropagation();
        onChange(providers[next]!.id);
        strip.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
    };

    return (
        <div ref={ strip } className={ styles.strip } role="tablist" aria-label="Provider" onKeyDown={ onKeyDown }>
            <For each={ providers }>
                { (provider) => {
                    const tab = (
                        <button
                            key={ provider.id }
                            type="button"
                            role="tab"
                            className={ styles.tab }
                            aria-label={ provider.name }
                            aria-selected={ provider.id === value }
                            tabIndex={ provider.id === value ? 0 : -1 }
                            data-tab={ provider.id }
                            onClick={ () => onChange(provider.id) }
                        >
                            <ProviderIcon agentId={ provider.id } size={ 16 } aria-hidden="true" />
                        </button>
                    );

                    return active ? <Tooltip key={ provider.id } content={ provider.name } placement="bottom">{ tab }</Tooltip> : tab;
                } }
            </For>
        </div>
    );
}

/**
 * The body of the flyout: it hears the flyout's keys and puts the focus on the first row of its list once the rows are there. React Aria's
 * own `autoFocus` of the list runs before the rows exist and the popover then takes the focus for itself, which leaves the arrows with
 * nothing to move.
 */
function FlyoutBody({ children, onKeyDown }: { children: ReactNode; onKeyDown: (event: KeyboardEvent) => void }) {
    const box = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let frame = 0;
        let tries = 0;

        const focusFirst = () => {
            const row = box.current?.querySelector<HTMLElement>('[role="option"]');

            if (row) row.focus();
            else if (tries++ < 20) frame = requestAnimationFrame(focusFirst);
        };

        focusFirst();

        return () => cancelAnimationFrame(frame);
    }, []);

    return <div ref={ box } className={ styles.flyoutBody } onKeyDown={ onKeyDown }>{ children }</div>;
}

/** The row that opens the flyout. It is a row of the list (the arrows reach it) that picks nothing. */
const MORE_KEY = 'more';

/** Only the primary button lets go of a row as a pick: a secondary press is the system's (a context menu), not the person's choice. */
const primary = (action: () => void) => (event: PointerEvent) => {
    if (event.button === 0) action();
};

interface ListProps {
    choice: ModelChoice;
    held: Held;
    providers: readonly PickerProvider[];
    /** The list is the pane in view. When it is not, what the person did in it (the provider they turned to, the flyout) is let go. */
    active: boolean;
    onBack: () => void;
    onPickModel: (provider: PickerProvider, model: AgentModel) => void;
}

/**
 * The second pane: a strip of the providers when there are several, then the main models of the one the strip shows and a "More models"
 * row that opens a flyout with the rest, or what that provider says instead (it is being read, or why it gives no models).
 */
function ModelList({ choice, held, providers, active, onBack, onPickModel }: ListProps) {
    const [viewed, setViewed] = useState<string>();
    const [flyoutFor, setFlyoutFor] = useState<string>();
    const [wasActive, setWasActive] = useState(active);
    const moreRow = useRef<HTMLDivElement>(null);
    const focusRowOnClose = useRef(false);

    // Out of view the list forgets its tab and its flyout, so the next opening starts on the provider in force.
    if (active !== wasActive) {
        setWasActive(active);

        if (!active) {
            setViewed(undefined);
            setFlyoutFor(undefined);
        }
    }

    const shown = providers.find(provider => provider.id === viewed) ?? providers.find(provider => provider.id === choice.engine) ?? providers[0];
    const rows = shown ? rowsOf(shown) : [];
    const selectedId = shown && held.provider?.id === shown.id ? held.model?.id : undefined;
    const main = mainModels(rows, selectedId);
    const more = moreModels(rows, selectedId);
    const note = shown ? noteOf(shown) : undefined;
    const selected = shown && selectedId !== undefined ? rowKey(shown.id, selectedId) : undefined;
    const byKey = new Map(rows.map(model => [rowKey(shown!.id, model.id), model] as const));
    const flyoutOpen = active && shown !== undefined && flyoutFor === shown.id && more.length > 0;

    const openFlyout = () => {
        if (shown) setFlyoutFor(shown.id);
    };

    // Escape and ArrowLeft in the flyout give the focus back to the row that opened it; a press outside it does not take the focus anywhere.
    // The row is out of reach (`inert`) while the flyout is open, so the focus goes once it is closed.
    const closeFlyout = (restoreFocus: boolean) => {
        focusRowOnClose.current = restoreFocus;
        setFlyoutFor(undefined);
    };

    useEffect(() => {
        if (flyoutOpen || !focusRowOnClose.current) return;

        focusRowOnClose.current = false;
        moreRow.current?.focus();
    }, [flyoutOpen]);

    const pickKey = (key: unknown) => {
        if (key === MORE_KEY) {
            openFlyout();

            return;
        }

        const model = typeof key === 'string' ? byKey.get(key) : undefined;

        if (shown && model) onPickModel(shown, model);
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
                onPointerUp={ primary(() => pickKey(key)) }
            />
        );
    };

    // ArrowRight on "More models" opens the flyout, as it would a submenu. It is read here, on the rows, and not on the pane, which also
    // hears what happens in the flyout (a React event goes up through its portal).
    const onRowsKeyDown = (event: KeyboardEvent) => {
        if (event.key !== 'ArrowRight' || !(event.target instanceof Element) || !event.target.closest('[data-more]')) return;

        event.preventDefault();
        event.stopPropagation();
        openFlyout();
    };

    const onFlyoutKeyDown = (event: KeyboardEvent) => {
        if (event.key !== 'Escape' && event.key !== 'ArrowLeft') return;

        event.preventDefault();
        event.stopPropagation();
        closeFlyout(true);
    };

    return (
        <div className={ styles.models }>
            <span className={ styles.listHead }>
                <Button size="sm" iconOnly variant="filling" color="secondary" aria-label="Back" onPress={ onBack }>
                    <ChevronLeft aria-hidden="true" />
                </Button>
                <Text className={ styles.listTitle }>Select model</Text>
            </span>

            <Show when={ providers.length > 1 && shown }>
                { current => <ProviderStrip providers={ providers } value={ current.id } active={ active } onChange={ setViewed } /> }
            </Show>

            <Scrollable className={ styles.modelScroll } onKeyDown={ onRowsKeyDown }>
                <Show when={ shown && rows.length > 0 }>
                    { /* One list per provider: the rows of another provider would otherwise be matched to the key the old list had focused, and Tab would land on its last row. */ }
                    <ListBox
                        key={ shown!.id }
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
                        <For each={ main }>{ model => renderRow(shown!, model) }</For>

                        <Show when={ more.length > 0 }>
                            <ListBoxItem
                                key={ MORE_KEY }
                                id={ MORE_KEY }
                                ref={ moreRow }
                                data-more=""
                                text="More models"
                                // The room of a mark, so the words stand under the names above.
                                icon={ <span className={ styles.markSlot } aria-hidden="true" /> }
                                endAffix={ <ChevronRight aria-hidden="true" /> }
                                onPointerUp={ primary(openFlyout) }
                            />
                        </Show>
                    </ListBox>
                </Show>

                <Show when={ shown && note }>
                    { current => (
                        <div className={ styles.note } data-provider={ shown!.id }>
                            { current.busy
                                ? (
                                    <span className={ styles.noteBusy }>
                                        <Spinner size="xs" />
                                        <Text className={ styles.noteText }>Reading the models…</Text>
                                    </span>
                                )
                                : (
                                    <>
                                        <Text className={ styles.noteText }>{ current.text }</Text>
                                        <Button size="xs" variant="bordered" onPress={ () => void shown!.list.reload() }>Retry</Button>
                                    </>
                                ) }
                        </div>
                    ) }
                </Show>
            </Scrollable>

            { /* The flyout is a popover of its own, beside the row, and may reach past the picker's edge: it is where there is room. */ }
            <Show when={ shown && more.length > 0 }>
                <Popover
                    isOpen={ flyoutOpen }
                    onOpenChange={ (open) => {
                        if (!open) closeFlyout(false);
                    } }
                    triggerRef={ moreRow }
                    placement="right top"
                    offset={ 16 }
                    spacing="none"
                    width={ 240 }
                    className={ styles.flyout }
                    aria-label="More models"
                    data-model-flyout=""
                >
                    <FlyoutBody onKeyDown={ onFlyoutKeyDown }>
                        <Scrollable className={ styles.flyoutScroll }>
                            <ListBox
                                className={ styles.modelList }
                                aria-label="More models"
                                size="sm"
                                selectionMode="single"
                                disallowEmptySelection
                                selectedKeys={ [] }
                                onSelectionChange={ (keys) => {
                                    if (keys !== 'all') pickKey([...keys][0]);
                                } }
                            >
                                <For each={ more }>{ model => renderRow(shown!, model) }</For>
                            </ListBox>
                        </Scrollable>
                    </FlyoutBody>
                </Popover>
            </Show>
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

        // The model in force (Claude's `default` and `opus` are one) just goes back to the face; any other is a pick, with the level it takes there.
        if (provider.id !== choice.engine || model.id !== held.model?.id) onPick(choiceForModel(provider.id, model, choice.effort, readRemembered()));

        setPicking(false);
    };

    // Escape in the list goes back to the face first; on the face it closes the popover, as ever. Enter or Space on the model in force
    // does the same: the listbox reports no change when its selected row is chosen again, so nothing else would answer the key. It is
    // read in the capture phase because a row's press handling stops its own Enter and Space before they bubble.
    const onListKeyDown = (event: KeyboardEvent) => {
        // A pick moves the focus to the model button while Enter is still down, and on a Mac neither the list nor the flyout cancels Enter's own
        // action, which is a click on whatever has the focus by then: it would press that button and open the list again. This is read
        // before the next check because the flyout's rows are meant too.
        if (event.key === 'Enter' && event.target instanceof Element && event.target.closest('[role="option"]')) event.preventDefault();

        // What happens in the flyout comes up through its portal to here: it is the flyout's own (it closes itself on Escape).
        if (!event.currentTarget.contains(event.target as Node)) return;

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
                <ModelList choice={ choice } held={ held } providers={ providers } active={ picking } onBack={ () => setPicking(false) } onPickModel={ pickModel } />
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
