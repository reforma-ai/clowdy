import type { ChatMode, Project, RunRole, Task } from '@clowdy/protocol';

/** The system skill each role starts from. It is invoked in the first message, because a skill listing alone is advisory. */
const ENTRY_SKILL: Record<RunRole, string> = {
    orchestrator: 'orchestrate',
    executor: 'executor',
    verifier: 'verify',
};

const ROLE_INTRO: Record<RunRole, string> = {
    orchestrator: 'You are the orchestrator of a Clowdy chat. Follow clowdy:orchestrate; it names the other system skills (clowdy:autopilot, clowdy:semi-manual, clowdy:scaffold, clowdy:docs).',
    executor: 'You are an executor run started by an orchestrator. Follow clowdy:executor. Never ask the user; finish with report_result.',
    verifier: 'You are a verifier run started by an orchestrator. Follow clowdy:verify. Never ask the user; fix nothing; finish with report_result.',
};

const modeLabel = (mode: ChatMode) => (mode === 'semi' ? 'semi-manual' : 'autopilot');

/** The system prompt: where the system skills are, the mode and the facts about the project. Everything else is in the skills. */
export function systemPrompt(role: RunRole, mode: ChatMode, project: Project): string {
    return [
        'Clowdy is a desktop app where a person who manages software work chats with an orchestrator and watches tasks, agents and documents while agents do the engineering.',
        ROLE_INTRO[role],
        `Mode: ${ modeLabel(mode) }.`,
        `Project: ${ project.name }, repository at ${ project.path }, task keys ${ project.taskPrefix }-<number>, project documents in .clowdy/docs/.`,
    ].join('\n');
}

/** The first message of a run: the entry skill, the mode and the content (the user's message, or what an orchestrator wrote for a child). */
export function firstMessage(role: RunRole, mode: ChatMode, content: string): string {
    return `/clowdy:${ ENTRY_SKILL[role] } Mode: ${ modeLabel(mode) }\n\n${ content }`;
}

/** What a task started from the task list says to its new chat's orchestrator. */
export function taskMessage(task: Task): string {
    const description = task.description.trim();

    return [
        `Complete task ${ task.key }: ${ task.title }`,
        description && `Description:\n${ description }`,
        `This chat is bound to ${ task.key }; read it with task_get, do the work, and finish with a short report.`,
    ].filter(Boolean).join('\n\n');
}

/** Sent to a run that was cut off by a subscription limit or a passing engine failure, once it can continue. */
export const CONTINUE_MESSAGE = 'The previous attempt was interrupted by a temporary problem (a usage limit or an overloaded service). Continue where you left off; do not redo finished work.';
