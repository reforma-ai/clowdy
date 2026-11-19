import { errorMessage } from '../../errors';
import { ProcessEnded } from './connection';
import { classifyFailure, failureEvent } from './failure';

import type { EngineEvent, SessionTitle } from '../types';

/*
 * What the protocol layers do the same way, whatever the version of ACP: choosing the model and the reasoning level among an agent's options,
 * naming the session, putting the system prompt and the record in front of the message, and what a prompt that ended without an answer means.
 */

/** A select option of an agent's session, read into one shape from either protocol's options. */
export interface SelectOption {
    id: string;
    category?: string | null;
    currentValue: string;
    choices: { value: string; name: string }[];
}

/** What to send to set an option: its id and the value, or nothing when the option is already on it. */
export interface ConfigChange {
    configId: string;
    value: string;
    /** The option is on this value already, so there is nothing to send. */
    unchanged: boolean;
}

/** The select options of one category: `model` picks the model, `thought_level` the reasoning level. */
const selectsOf = (options: SelectOption[], category: string): SelectOption[] => options.filter(option => option.category === category);

/** The choice of `option` called `wanted`, by value or by name, case-insensitive. */
function changeTo(option: SelectOption, wanted: string): ConfigChange | undefined {
    const lower = wanted.toLowerCase();
    const match = option.choices.find(choice => choice.value.toLowerCase() === lower) ?? option.choices.find(choice => choice.name.toLowerCase() === lower);

    return match && { configId: option.id, value: match.value, unchanged: option.currentValue === match.value };
}

/** The id of the option that picks the model, and the value of `model` among its choices (by value or by name). */
function modelChoice(options: SelectOption[], model: string): ConfigChange | undefined {
    const [option] = selectsOf(options, 'model');

    return option && changeTo(option, model);
}

/**
 * The reasoning option that has a choice called `effort`. An agent names it as it likes (Claude `effort`, Codex `reasoning_effort`, one of
 * Cursor's several per model), and a model may carry other `thought_level` options with other values (Cursor's `thinking`), so the option is
 * found by the value it offers. Call it on the options the agent reported after the model was set: a model decides which levels exist.
 */
function effortChoice(options: SelectOption[], effort: string): ConfigChange | undefined {
    for (const option of selectsOf(options, 'thought_level')) {
        const change = changeTo(option, effort);

        if (change) {
            return change;
        }
    }

    return undefined;
}

export interface Choices {
    agent: string;
    /** The options the agent opened the session with. */
    options: SelectOption[];
    model?: string;
    effort?: string;
    /** Sends one change; gives back the options as they are now, or nothing when the answer lists none. */
    set(change: ConfigChange): Promise<SelectOption[] | undefined>;
}

/**
 * Puts the session on the model and the reasoning level the run asked for, where the agent offers them. The model goes first: it decides which
 * levels the agent offers, and the answer to a change lists the options as they are now. A choice the agent does not offer is logged and left to it.
 */
export async function applyChoices({ agent, options, model, effort, set }: Choices): Promise<void> {
    let current = options;

    if (model) {
        const choice = modelChoice(current, model);

        if (!choice) {
            console.warn(`[clowdy] ${ agent } offers no model called "${ model }"; it keeps its own choice`);
        }
        else if (!choice.unchanged) {
            current = await set(choice) ?? current;
        }
    }

    if (effort) {
        const choice = effortChoice(current, effort);

        if (!choice) {
            console.warn(`[clowdy] ${ agent } offers no reasoning level called "${ effort }"${ model ? ` for ${ model }` : '' }; it keeps its own choice`);
        }
        else if (!choice.unchanged) {
            await set(choice);
        }
    }
}

/**
 * Gives the agent the title the runtime keeps, before the first message: the agent keeps a title the client gave and makes none of its own (ACP says
 * so, and both adapters do). Only for a session the agent names itself (`naming`), which is a new one. `send` makes the request.
 */
export async function keepTitle({ agent, signal, title, naming }: { agent: string; signal: AbortSignal; title?: SessionTitle; naming: boolean }, send: (title: string) => Promise<unknown>): Promise<void> {
    if (!title || !('keep' in title) || !naming) {
        return;
    }

    try {
        await send(title.keep);
    }
    catch (error) {
        if (signal.aborted || error instanceof ProcessEnded) {
            throw error;
        }

        // Not fatal: the agent names the session as it would have, and the runtime ignores the name.
        console.warn(`[clowdy] ${ agent } would not take a title for its session: ${ errorMessage(error) }`);
    }
}

/**
 * What goes in front of the first message of a conversation the agent has not seen: the system prompt, when the agent cannot take one in the session
 * request, and the record of the conversation, when this session replaces one that could not be continued. Each part ends in a rule.
 */
export function prefaceOf({ systemPrompt, supportsSystemPrompt, resumed, record }: { systemPrompt?: string; supportsSystemPrompt: boolean; resumed: boolean; record?: string }): string {
    return [!supportsSystemPrompt && !resumed && systemPrompt, record].filter(Boolean).map(part => `${ part }\n\n---\n\n`).join('');
}

/**
 * Codex warns, as an assistant message right after it resumes a session, that the session was recorded with another model than the one
 * it resumes with. Clowdy resumes on the person's own settings and changes the model to the chat's before the prompt, so the warning is noise.
 */
const RESUME_WARNING = /^Warning: This session was recorded with model /;

export const isResumeWarning = (text: string): boolean => RESUME_WARNING.test(text);

/** A prompt can end for a reason that is not a finished answer. */
export function stopFailure(reason: string | null | undefined, agent: string): EngineEvent | undefined {
    switch (reason) {
        case 'max_tokens':
            return { type: 'error', message: `${ agent } stopped because it reached the limit on the length of an answer.`, code: 'unknown' };
        case 'max_turn_requests':
            return { type: 'error', message: `${ agent } stopped because it reached its limit on steps in one turn.`, code: 'unknown' };
        case 'refusal':
            return failureEvent(classifyFailure({ agent, text: 'The agent declined the request', kind: 'invalid_request' }));
        default:
            return undefined;
    }
}
