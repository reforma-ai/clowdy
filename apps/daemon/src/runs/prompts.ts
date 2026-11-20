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

const INTRO = 'You are the orchestrator of a Clowdy chat. Follow clowdy:orchestrate; it names the other system skills (clowdy:autopilot, clowdy:semi-manual, clowdy:scaffold, clowdy:docs).';

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
 * The system prompt: where the system skills are, the mode and the facts about the project. Everything else is in the skills. `cwd` is the folder
 * the run works in.
 */
export function systemPrompt(mode: ChatMode, project: Project, cwd = mainFolder(project).path): string {
    return [
        'Clowdy is a desktop app where a person who manages software work chats with an orchestrator and watches tasks, agents and documents while agents do the engineering.',
        INTRO,
        `Mode: ${ modeLabel(mode) }.`,
        projectFacts(project, cwd),
    ].join('\n');
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
 * The entry skill, in the system prompt, with where the other system skills are. No agent is asked to load a plugin: the skill it starts from is here,
 * and the rest are files it reads when that skill says to follow them.
 */
export function skillPrompt(skillsDir: string | undefined): string {
    if (!skillsDir) {
        return '';
    }

    const body = skillBody(skillsDir, ENTRY_SKILL);

    return [
        `System skills are plain files: \`clowdy:<name>\` is ${ join(skillsDir, 'skills', '<name>', 'SKILL.md') }, and a skill's references/ folder is beside its SKILL.md. The skill you start from is below; read any other one with your file tool when a skill tells you to follow it.`,
        body && `<skill name="clowdy:${ ENTRY_SKILL }">\n${ body }\n</skill>`,
    ].filter(Boolean).join('\n\n');
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
        `This chat is bound to ${ task.key }; read it with task_get, do the work, and finish with a short report.`,
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

/** The longest title of a background item that goes into a sentence. */
const MAX_NAMED_TITLE = 80;

/** A background item's title for a sentence: one line, cut at about 80 characters (a command's title may be a whole script). */
export const namedTitle = (title: string) => clip(title.replace(/\s+/g, ' ').trim(), MAX_NAMED_TITLE);

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
