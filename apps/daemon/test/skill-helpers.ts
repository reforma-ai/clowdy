import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Writes `<root>/<folder>/SKILL.md`. `raw` replaces the generated file. Returns the skill's folder. */
export function writeSkill(root: string, folder: string, description = `Does ${ folder } work`, raw?: string): string {
    const dir = join(root, folder);

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), raw ?? `---\nname: ${ folder }\ndescription: ${ JSON.stringify(description) }\n---\n\n# ${ folder }\n`);

    return dir;
}
