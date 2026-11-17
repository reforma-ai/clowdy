/**
 * Checks every skill folder: `skills/<name>/SKILL.md` has YAML front matter with `name` equal to the folder
 * and a non-empty `description` (Codex requires it), stays under the size caps, and links only to files that exist.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const skillsDir = path.join(root, 'skills');
const MAX_BODY_BYTES = 24_000;
const MAX_DESCRIPTION_CHARS = 1_000;
const problems: string[] = [];

const manifest = JSON.parse(readFileSync(path.join(root, '.claude-plugin/plugin.json'), 'utf8')) as { name?: string };

if (manifest.name !== 'clowdy') problems.push('.claude-plugin/plugin.json: name must be "clowdy" (it is the namespace of every skill)');

const names = readdirSync(skillsDir).filter(entry => statSync(path.join(skillsDir, entry)).isDirectory());

if (names.length === 0) problems.push('skills/: no skills found');

for (const name of names) {
    const file = path.join(skillsDir, name, 'SKILL.md');

    if (!existsSync(file)) {
        problems.push(`skills/${ name }: SKILL.md is missing`);
        continue;
    }

    const text = readFileSync(file, 'utf8');
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);

    if (!match) {
        problems.push(`skills/${ name }/SKILL.md: front matter is missing`);
        continue;
    }

    const [, frontMatter, body] = match;
    const field = (key: string) => new RegExp(`^${ key }:\\s*(.*)$`, 'm').exec(frontMatter)?.[1]?.trim().replace(/^["']|["']$/g, '');

    if (field('name') !== name) problems.push(`skills/${ name }/SKILL.md: name must equal the folder name`);

    const description = field('description');

    if (!description) problems.push(`skills/${ name }/SKILL.md: description is required`);
    else if (description.length > MAX_DESCRIPTION_CHARS) problems.push(`skills/${ name }/SKILL.md: description is over ${ MAX_DESCRIPTION_CHARS } characters`);

    if (Buffer.byteLength(body) > MAX_BODY_BYTES) problems.push(`skills/${ name }/SKILL.md: body is over ${ MAX_BODY_BYTES } bytes; move detail into references/`);

    for (const link of body.matchAll(/\]\((?!https?:|#)([^)\s]+)\)/g)) {
        if (!existsSync(path.join(skillsDir, name, link[1].split('#')[0]))) problems.push(`skills/${ name }/SKILL.md: broken link ${ link[1] }`);
    }
}

if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exit(1);
}

console.log(`${ names.length } skills OK: ${ names.join(', ') }`);
