import { useMemo, useState } from 'react';

import { useAgentModels, useAgents, useRootStore } from '../../stores';
import { isUsableProvider, providerAgents } from '../settings/providers/providerView';
import { perform } from './commands';
import { readRemembered, remember, startingChoice, startingEngine, writeRemembered, type ModelChoice } from './modelSelection';

import type { Chat, Run } from '@clowdy/protocol';
import type { PickerProvider } from './ModelPicker';

/** Why the new-chat page cannot send: no agent is switched on and installed. */
export const NO_PROVIDER_HINT = 'Turn on a provider in Settings > Providers';

/** What a chat, or an orchestrator run, says it runs on. A chat from before chats had a choice of their own says nothing: its run does. */
function choiceOf(source: Pick<Chat, 'engine' | 'model' | 'effort'> | undefined): ModelChoice | undefined {
    return source?.engine ? { engine: source.engine, ...(source.model && { model: source.model }), ...(source.effort && { effort: source.effort }) } : undefined;
}

interface ModelChoiceArgs {
    /** The chat the composer is on, live from the store. Absent on the new-chat page. */
    chat: Chat | undefined;
    /** The chat a first message made when sending it failed: a snapshot, so what is picked afterwards is kept here. */
    made: Chat | undefined;
    /** The orchestrator of `chat`. */
    run: Run | undefined;
}

export interface ModelChoiceState {
    /** What the picker holds and the first message creates the chat with. Nothing for a chat that has no choice of its own. */
    choice: ModelChoice | undefined;
    /** The providers the picker lists: those that can be used, or the chat's own once its orchestrator has started. */
    providers: PickerProvider[];
    /** The new-chat page has no provider to start the chat on. */
    noProvider: boolean;
    /** The person picked a model, or another level of it. */
    pick: (next: ModelChoice) => void;
}

/**
 * The model choice behind the composer's picker. On the new-chat page it starts from what the person last picked on this machine
 * (`startingChoice`), looks again as the models arrive until they pick, and holds their pick from then on. In a chat it is the chat's
 * own (`engine`, `model`, `effort`, from the store as they change), and a pick sends `chat.setModel`; before the orchestrator has
 * started the provider may change too. Every pick is remembered for the next new chat.
 */
export function useModelChoice({ chat, made, run }: ModelChoiceArgs): ModelChoiceState {
    const root = useRootStore();
    const { agents, status } = useAgents();
    const [remembered] = useState(readRemembered);
    const [picked, setPicked] = useState<ModelChoice>();
    const target = chat ?? made;
    // From the first message on, the provider is fixed.
    const started = target?.orchestratorRunId !== undefined;
    const usable = providerAgents(agents).filter(isUsableProvider);
    // A chat holds its own choice; the new-chat page holds the pick, else the one it starts from.
    const fixed = chat ? (choiceOf(chat) ?? choiceOf(run)) : (picked ?? choiceOf(made));
    const starting = !chat && !fixed;
    const engine = starting ? startingEngine(usable.map(agent => agent.id), remembered) : fixed?.engine;
    const list = useAgentModels(engine);
    const models = list?.models?.state === 'ok' ? list.models.models : [];
    const choice = starting ? (engine ? startingChoice(engine, models, remembered) : undefined) : fixed;
    const offered = started ? (choice ? [choice.engine] : []) : usable.map(agent => agent.id);
    const offeredKey = offered.join('\n');
    // The same array until the agents change, so the picker's effects do not run on every render.
    const providers = useMemo<PickerProvider[]>(
        () => (offeredKey === '' ? [] : offeredKey.split('\n')).map(id => ({ id, name: agents.find(agent => agent.id === id)?.name ?? id, list: root.models.of(id) })),
        [offeredKey, agents, root]
    );

    const pick = (next: ModelChoice) => {
        const keep = () => writeRemembered(remember(readRemembered(), next));

        if (!target) {
            setPicked(next);
            keep();

            return;
        }

        void (async () => {
            const result = await perform(root, {
                type: 'chat.setModel',
                chatId: target.id,
                // Only a chat that has not started lists another provider, so another provider here is a change the daemon allows.
                ...(next.engine !== choice?.engine && { engine: next.engine }),
                ...(next.model && { model: next.model }),
                // A model with no levels leaves none to carry over.
                effort: next.effort ?? null,
            });

            if (!result.ok) return;

            if (!chat) setPicked(next);

            keep();
        })();
    };

    return { choice, providers, noProvider: !chat && !made && usable.length === 0 && status !== 'loading', pick };
}
