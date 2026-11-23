import { homedir } from 'node:os';
import { join } from 'node:path';
import { folderNames } from '@clowdy/protocol';

import { getProject, listProjects } from '../db/projects';
import { invalid, notFound } from '../errors';
import { buildCatalog, mergeUserSkills } from './catalog';
import { defaultSystemSkillsSource, materializeSystemSkills, SYSTEM_PLUGIN_NAME } from './materialize';
import { buildUserMirror, USER_PLUGIN_NAME } from './mirror';
import { SkillScanner } from './scan';
import { SkillSettings } from './settings';
import { FolderWatchers } from './watch';

import type { Project, SkillCatalog } from '@clowdy/protocol';
import type { Config } from '../config';
import type { Store } from '../store';
import type { LabeledScan, ProjectScan } from './catalog';
import type { RootScan } from './scan';

/** A project's skill folders, relative to each of its folders, and the engine that reads each. */
const PROJECT_ROOTS = [
    { dir: '.claude/skills', engine: 'claude' },
    { dir: '.agents/skills', engine: 'codex' },
] as const;

const skillDirs = (project: Project) =>
    project.folders.flatMap(folder => PROJECT_ROOTS.map(({ dir }) => join(folder.path, dir)));

const fingerprintOf = (scans: readonly { scan: RootScan }[]) => scans.map(({ scan }) => scan.fingerprint).join('|');

/**
 * What the engines get as skills. Owns the system skills copy, the catalog the API serves, which user skills are
 * on, and the `user` plugin that carries the enabled ones; keeps the last two in `config` for the engines
 * (`systemSkillsDir`, `extraPluginDirs`) and announces `skills.changed` when a skill folder changes.
 * Project skills are not mirrored: Claude reads them through `settingSources: ['project']`, Codex from the repository.
 */
export class SkillsService {
    private scanner = new SkillScanner();
    private settings: SkillSettings;
    private watchers = new FolderWatchers();
    private systemDir: string;
    /** What the last announcement (or the start) saw, to tell a real change from a touched file. */
    private userFingerprint?: string;
    private projectFingerprints = new Map<string, string>();

    /** Materializes the system skills and builds the user plugin; throws when the system skills are missing. */
    constructor(
        private store: Store,
        private config: Config
    ) {
        this.settings = new SkillSettings(config.dataDir);
        this.systemDir = materializeSystemSkills(
            config.systemSkillsSource ?? defaultSystemSkillsSource(),
            config.dataDir
        ).dir;
        config.systemSkillsDir = this.systemDir;
        this.syncUser();
    }

    /** Starts watching the user's skill folders and those of `projects`. */
    watchFolders(projects: readonly Project[]): void {
        this.watchUser();
        projects.forEach(project => this.watchProject(project));
    }

    /**
     * Lets go of a project's skill folders: it was removed, or its folders changed. The watchers and the fingerprint are
     * rebuilt for whatever folders the project has when its catalog is asked for next.
     */
    forgetProject(project: Project): void {
        skillDirs(project).forEach(dir => this.watchers.unwatch(project.id, dir));
        this.projectFingerprints.delete(project.id);
    }

    stop(): void {
        this.watchers.stop();
    }

    /** The skills a run sees: system and user ones, and with `project` also the project's. */
    catalog(project?: Project): SkillCatalog {
        this.watchUser();

        // A folder that did not exist at start had no watcher, so nothing told the `user` plugin about the skills it holds now.
        if (this.syncUser()) {
            this.announce(listProjects(this.store.db));
        }

        if (project) {
            this.watchProject(project);
        }

        const { disabled, warning } = this.settings.read();

        return buildCatalog({
            system: this.scanner.scan(join(this.systemDir, 'skills')),
            user: mergeUserSkills(this.userScans()),
            project: project ? this.projectScans(project) : [],
            disabled,
            warnings: warning ? [warning] : [],
        });
    }

    /** Switches a user skill on or off for every run; `name` is the entry's name (`user:deploy`). */
    setEnabled(name: string, enabled: boolean): void {
        if (name.startsWith(`${SYSTEM_PLUGIN_NAME}:`)) {
            throw invalid('System skills cannot be switched off');
        }

        if (!name.startsWith(`${USER_PLUGIN_NAME}:`)) {
            throw invalid(`Only user skills (named ${USER_PLUGIN_NAME}:<skill>) can be switched on or off`);
        }

        const folder = name.slice(USER_PLUGIN_NAME.length + 1);

        if (!mergeUserSkills(this.userScans()).skills.some(skill => skill.folder === folder)) {
            throw notFound('Skill', name);
        }

        if (this.settings.setEnabled(folder, enabled)) {
            this.rebuildMirror();
            this.announce(listProjects(this.store.db));
        }
    }

    private userScans(): LabeledScan[] {
        const home = homedir();

        return (this.config.userSkillRoots ?? []).map(dir => ({
            label: dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir,
            scan: this.scanner.scan(dir),
        }));
    }

    /** Every skill folder of every project folder; with several folders the label starts with the folder's name (`web/.claude/skills`). */
    private projectScans(project: Project): ProjectScan[] {
        const names = folderNames(project.folders);

        return project.folders.flatMap((folder, index) =>
            PROJECT_ROOTS.map(({ dir, engine }) => ({
                label: project.folders.length === 1 ? dir : `${names[index]}/${dir}`,
                engine,
                scan: this.scanner.scan(join(folder.path, dir)),
            }))
        );
    }

    /** Rebuilds the `user` plugin when the folders changed since the last look. Returns whether they did. */
    private syncUser(): boolean {
        const fingerprint = fingerprintOf(this.userScans());

        if (fingerprint === this.userFingerprint) {
            return false;
        }

        this.userFingerprint = fingerprint;
        this.rebuildMirror();

        return true;
    }

    private rebuildMirror(): void {
        const { disabled } = this.settings.read();
        const enabled = mergeUserSkills(this.userScans()).skills.filter(skill => !disabled.has(skill.folder));
        const dir = buildUserMirror(this.config.dataDir, enabled);

        this.config.extraPluginDirs = dir ? [dir] : [];
    }

    private watchUser(): void {
        for (const root of this.config.userSkillRoots ?? []) {
            this.watchers.watch('user', root, () => {
                if (this.syncUser()) {
                    this.announce(listProjects(this.store.db));
                }
            });
        }
    }

    private watchProject(project: Project): void {
        if (!this.projectFingerprints.has(project.id)) {
            this.projectFingerprints.set(project.id, fingerprintOf(this.projectScans(project)));
        }

        for (const dir of skillDirs(project)) {
            this.watchers.watch(project.id, dir, () => this.refreshProject(project.id));
        }
    }

    private refreshProject(projectId: string): void {
        const project = getProject(this.store.db, projectId);

        if (!project) {
            return;
        }

        const fingerprint = fingerprintOf(this.projectScans(project));

        if (fingerprint !== this.projectFingerprints.get(projectId)) {
            this.projectFingerprints.set(projectId, fingerprint);
            this.announce([project]);
        }
    }

    private announce(projects: readonly Project[]): void {
        this.store.tx(() => {
            for (const { id } of projects) {
                this.store.emit(id, { type: 'skills.changed' });
            }
        });
    }
}
