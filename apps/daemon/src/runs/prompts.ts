import { mainFolder } from '@clowdy/protocol';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { clip } from './tool-kit';

import type { BackgroundItem, ChatMode, Project, Task } from '@clowdy/protocol';

/**
 * The system skill every run the daemon drives starts from: each one is a chat's orchestrator. It is named in the first message and its text is in the
 * system prompt, because a skill listing alone is advisory.
 */
const ENTRY_SKILL = 'orchestrate';

/** The system skill a thread's orchestrator also has in its system prompt: how a thread takes its assignment and reports to its parent. */
const THREAD_SKILL = 'thread';

const INTRO = 'You are the orchestrator of a Clowdy chat. Follow clowdy:orchestrate; it names the other system skills (clowdy:autopilot, clowdy:semi-manual, clowdy:scaffold, clowdy:docs).';

/**
 * What every orchestrator is told about the task tools. Most agents have them as the shell command `clowdy task`; one that uses the MCP door
 * (`AgentSpec.taskTools`) has them as tools of the same names and fields, and this line serves both, so the prompt does not depend on the door.
 */
const TASKS = 'Tasks: read and change them with the shell command `clowdy task` (`clowdy task --help`). Where your tool list has `task_get`, `task_list`, `task_create` and `task_update`, those are the same commands, with the flags as camelCase fields. `clowdy task list` shows only the work in flight and pages long answers: never list everything.';

/** What every chat's orchestrator is told about threads; clowdy:orchestrate says how to delegate. */
const THREADS = [
    'Threads: you can hand work to other agents as threads, chats below yours that run alongside you, with the shell command `clowdy thread` (`clowdy thread --help` lists its commands; `"$CLOWDY_CLI"` is the same command if your shell does not find `clowdy`). It reaches the Clowdy daemon over a loopback connection: if a sandboxed shell refuses it (`EPERM`), run the same command again with escalated permissions, outside the sandbox.',
    'Delegate only when the person asked for it or the work really splits into independent pieces. A thread does not see this conversation, so give it a self-contained brief.',
    'Its last message of a turn is its report, which the daemon delivers to you as a message each time it stops: end your turn instead of waiting, and never poll. Never send a thread acknowledgements or thanks.',
].join(' ');

/** The chat a thread's orchestrator reports to. */
export interface PromptParent {
    id: string;
    title: string;
}

/** What the system prompt says about the run's chat: present for every run of a chat, with the parent when the chat is a thread. */
export interface PromptChat {
    parent?: PromptParent;
}

/** What the orchestrator of a thread is told about its place: who started it, what its report is, and whom it may write to. */
function threadIntro(parent: PromptParent): string {
    return [
        `This chat is a thread: the chat "${ parent.title }" (${ parent.id }) started it, and the first message is your assignment from that chat.`,
        'Your last message of each turn is your report to it, delivered when you stop: the verdict first (done, partly done, failed or blocked), then the evidence (what you ran and saw), then what is left.',
        `Ask your parent with \`clowdy thread tell ${ parent.id } "<question>"\` only when you are blocked. Write to no other chat unless your assignment says so. You may start threads of your own while the depth limit allows.`,
        'Follow clowdy:thread as well.',
    ].join(' ');
}

const modeLabel = (mode: ChatMode) => (mode === 'semi' ? 'semi-manual' : 'autopilot');

/**
 * What the agent is told about the project. No folder is called a repository: any folder can be a project's. Several folders are each named by
 * absolute path: an agent that takes no additional folders reaches the others only that way, and none reads another folder's instructions unless
 * told to. The folder the run works in is marked, which is not the main one for a run whose `cwd` is another folder.
 */
function projectFacts(project: Project, cwd: string): string {
    const keys = `task keys ${ project.taskPrefix }-<number>`;

    if (project.folders.length === 1) {
        const folder = mainFolder(project).path;
        const where = project.personal ? `the person's personal space, a folder at ${ folder } that belongs to no repository` : `folder at ${ folder }`;

        return `Project: ${ project.name }, ${ where }, ${ keys }, project documents in .clowdy/docs/.`;
    }

    const folders = project.folders.map(({ path }, index) => {
        const marks = [index === 0 && 'main', path === cwd && 'you work here'].filter(Boolean);

        return marks.length > 0 ? `- ${ path } (${ marks.join(', ') })` : `- ${ path }`;
    });

    return [
        `Project: ${ project.name }, ${ keys }, folders (use absolute paths outside the folder you work in):`,
        ...folders,
        'Each folder may have its own AGENTS.md or CLAUDE.md; read it before you change files in that folder.',
        'Documents: each folder has its own .clowdy/docs/. A document about one folder goes into that folder\'s; one about several folders or the whole project goes into the main folder\'s.',
    ].join('\n');
}

/**
 * The system prompt: where the system skills are, the mode, the facts about the project and, for a run of a chat, a paragraph on threads; a thread's
 * run is also told whose thread it is. Everything else is in the skills. `cwd` is the folder the run works in.
 */
export function systemPrompt(mode: ChatMode, project: Project, cwd = mainFolder(project).path, chat?: PromptChat): string {
    return [
        'Clowdy is a desktop app where a person who manages software work chats with an orchestrator and watches tasks, agents and documents while agents do the engineering.',
        INTRO,
        chat?.parent && threadIntro(chat.parent),
        `Mode: ${ modeLabel(mode) }.`,
        projectFacts(project, cwd),
        TASKS,
        chat && THREADS,
    ].filter(Boolean).join('\n');
}

/**
 * The text of a skill without its front matter, or `undefined` when it cannot be read. Skills are plain `SKILL.md`
 * files, so any agent can read them; loading them as a plugin is something only Claude Code does.
 */
function skillBody(skillsDir: string, name: string): string | undefined {
    try {
        return readFileSync(join(skillsDir, 'skills', name, 'SKILL.md'), 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
    }
    catch {
        return undefined;
    }
}

/**
 * The entry skill, in the system prompt, with where the other system skills are, and for a thread's run the thread skill after it. No agent is asked to
 * load a plugin: the skills it starts from are here, and the rest are files it reads when a skill says to follow them.
 */
export function skillPrompt(skillsDir: string | undefined, thread = false): string {
    if (!skillsDir) {
        return '';
    }

    const blocks = (thread ? [ENTRY_SKILL, THREAD_SKILL] : [ENTRY_SKILL]).flatMap((name) => {
        const body = skillBody(skillsDir, name);

        return body ? [`<skill name="clowdy:${ name }">\n${ body }\n</skill>`] : [];
    });

    return [
        `System skills are plain files: \`clowdy:<name>\` is ${ join(skillsDir, 'skills', '<name>', 'SKILL.md') }, and a skill's references/ folder is beside its SKILL.md. The ${ thread ? 'skills you start from are' : 'skill you start from is' } below; read any other one with your file tool when a skill tells you to follow it.`,
        ...blocks,
    ].join('\n\n');
}

/** What every first message of a run starts with. */
export const FIRST_MESSAGE_START = 'Follow clowdy:';

/** The first message of a run: the entry skill, the mode and the content (the user's message, or the task a chat was started from). */
export function firstMessage(mode: ChatMode, content: string): string {
    return `${ FIRST_MESSAGE_START }${ ENTRY_SKILL }. Mode: ${ modeLabel(mode) }\n\n${ content }`;
}

/** What a task started from the task list says to its new chat's orchestrator. */
export function taskMessage(task: Task): string {
    const description = task.description.trim();

    return [
        `Complete task ${ task.key }: ${ task.title }`,
        description && `Description:\n${ description }`,
        `This chat is bound to ${ task.key }; read it with \`clowdy task get ${ task.key }\`, do the work, and finish with a short report.`,
    ].filter(Boolean).join('\n\n');
}

/** Sent to a run that was cut off by a subscription limit or a passing engine failure, once it can continue. */
export const CONTINUE_MESSAGE = 'The previous attempt was interrupted by a temporary problem (a usage limit or an overloaded service). Continue where you left off; do not redo finished work.';

/**
 * Put before the message of a turn that stop and send starts (`ChatQueue.dispatch` after `RunDriver.interrupt`): the agent did not stop its last turn,
 * the runtime did, to make room for this message, so whatever it was doing may be unfinished. Only the agent reads it; the person's bubble does not have it.
 */
export const STOPPED_TURN_MESSAGE = 'Your previous turn was stopped so this message could be sent; what it was doing may be unfinished.';

/** What the person reads of a background item's kind, in a line of the stream ("Background command finished: ...") and in the agent's message. */
export const BACKGROUND_KINDS: Record<BackgroundItem['kind'], string> = {
    command: 'command',
    subagent: 'sub-agent',
    task: 'task',
};

/** The title of a task that the engine holds the session for until a time the agent scheduled in the call (a `Monitor`, a `ScheduleWakeup`, a one-shot cron job): `Monitor · <what>`, `Wakeup · <why>`. */
const SCHEDULED_TITLE = /^(Monitor|Wakeup) · (.+)$/;

/** The longest title of a background item that goes into a sentence. */
const MAX_NAMED_TITLE = 80;

/** A background item's title for a sentence: one line, cut at about 80 characters (a command's title may be a whole script). */
export const namedTitle = (title: string) => clip(title.replace(/\s+/g, ' ').trim(), MAX_NAMED_TITLE);

/**
 * The line the stream gets when an item has left the list ("Background command finished: bun test"). Of a monitor or a wakeup the runtime knows that its
 * time has passed, not what came of it (the agent reports that in the turn the event starts), so the line says only that: `Monitor ended: <what>`,
 * `Wakeup due: <why>`.
 */
export function backgroundNote(item: BackgroundItem, stopped: boolean): string {
    const scheduled = item.kind === 'task' && !stopped ? SCHEDULED_TITLE.exec(item.title) : null;

    return scheduled
        ? `${ scheduled[1] === 'Monitor' ? 'Monitor ended' : 'Wakeup due' }: ${ namedTitle(scheduled[2]) }`
        : `Background ${ BACKGROUND_KINDS[item.kind] } ${ stopped ? 'stopped' : 'finished' }: ${ namedTitle(item.title) }`;
}

/**
 * Told to an agent that starts no turn of its own when its background work ends (`wakesOnBackgroundEnd`, Codex), in a prompt of the runtime's own, once the
 * last item has left the list and nothing runs: one line per item that is over, so that it looks at what came of it and reports. Claude Code starts that
 * turn itself and is never sent this. `stopped` is an item the person ended with a Stop of its own. Only the agent reads it; the stream has a note per item.
 */
export function backgroundEndedMessage(ended: readonly { item: BackgroundItem; stopped: boolean }[]): string {
    return [
        ...ended.map(({ item, stopped }) => `Background ${ BACKGROUND_KINDS[item.kind] } ${ stopped ? 'stopped by the user' : 'finished' }: ${ namedTitle(item.title) }`),
        `Check how ${ ended.length === 1 ? 'it' : 'they' } went and tell the user what came of ${ ended.length === 1 ? 'it' : 'them' }, briefly.`,
    ].join('\n');
}

/**
 * Told to the agent, in a prompt of the runtime's own, when the person stopped one background item alone (a Stop on its row): that item is over, but a
 * stopped command gives the agent no report of its own (Claude Code starts no turn for it), so nothing would tell it.
 */
export function backgroundStoppedMessage(item: BackgroundItem): string {
    return `The user stopped the background ${ BACKGROUND_KINDS[item.kind] }: ${ namedTitle(item.title) }\nIt did not finish, and no result of it will arrive. Carry on without it, and say in one short sentence what that changes for your work.`;
}

/**
 * Told to the agent with the first message after its session was cut off (a Stop, a restart, a failure): what it had running in the background is gone,
 * whatever its state was, and nobody will report on it. The agent decides whether to start it again.
 */
export function lostBackgroundMessage(items: readonly BackgroundItem[]): string {
    return [
        'The background work you had running was lost when your session was cut off (stopped, restarted or failed). It did not finish, and no result of it will arrive. Start it again if it is still needed.',
        ...items.map(item => `- ${ BACKGROUND_KINDS[item.kind] }: ${ namedTitle(item.title) }`),
    ].join('\n');
}
