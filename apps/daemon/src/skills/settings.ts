import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const fileSchema = z.object({ disabled: z.array(z.string()) });

/**
 * Which user skills are switched off, in `<dataDir>/skills.json` as `{ "disabled": ["name"] }`. A list of what is
 * off, not of what is on, so a skill the person adds later starts enabled. Names are skill folder names.
 */
export class SkillSettings {
    private readonly file: string;

    constructor(dataDir: string) {
        this.file = join(dataDir, 'skills.json');
    }

    /** The switched-off names. A file that cannot be read leaves everything on, and says so. */
    read(): { disabled: Set<string>; warning?: string } {
        if (!existsSync(this.file)) {
            return { disabled: new Set() };
        }

        try {
            return { disabled: new Set(fileSchema.parse(JSON.parse(readFileSync(this.file, 'utf8'))).disabled) };
        } catch {
            return {
                disabled: new Set(),
                warning: 'skills.json in the data folder cannot be read, so every user skill is on',
            };
        }
    }

    /** Returns whether the setting changed. */
    setEnabled(name: string, enabled: boolean): boolean {
        const { disabled } = this.read();

        if (disabled.has(name) === !enabled) {
            return false;
        }

        if (enabled) {
            disabled.delete(name);
        } else {
            disabled.add(name);
        }

        const temp = `${this.file}.tmp`;

        writeFileSync(temp, `${JSON.stringify({ disabled: [...disabled].sort() }, null, 4)}\n`);
        renameSync(temp, this.file);

        return true;
    }
}
