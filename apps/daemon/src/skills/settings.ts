import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const fileSchema = z.object({ disabled: z.array(z.string()), systemDisabled: z.array(z.string()).optional() });

/**
 * Which user and system skills are switched off, in `<dataDir>/skills.json` as `{ "disabled": ["name"] }`. A list of what is
 * off, not of what is on, so a skill the person adds later starts enabled. Names are skill folder names.
 */
export class SkillSettings {
    private readonly file: string;

    constructor(dataDir: string) {
        this.file = join(dataDir, 'skills.json');
    }

    /** The switched-off names. A file that cannot be read leaves everything on, and says so. */
    read(): { disabled: Set<string>; systemDisabled: Set<string>; warning?: string } {
        if (!existsSync(this.file)) {
            return { disabled: new Set(), systemDisabled: new Set() };
        }

        try {
            const data = fileSchema.parse(JSON.parse(readFileSync(this.file, 'utf8')));
            return { disabled: new Set(data.disabled), systemDisabled: new Set(data.systemDisabled ?? []) };
        } catch {
            return {
                disabled: new Set(),
                systemDisabled: new Set(),
                warning: 'skills.json in the data folder cannot be read, so every skill is on',
            };
        }
    }

    /** Returns whether the setting changed. A damaged file is kept as `skills.json.damaged` before it is replaced. */
    setEnabled(name: string, enabled: boolean, system = false): boolean {
        const settings = this.read();
        const disabled = system ? settings.systemDisabled : settings.disabled;

        if (disabled.has(name) === !enabled) {
            return false;
        }

        if (enabled) {
            disabled.delete(name);
        } else {
            disabled.add(name);
        }

        // A file that could not be read is kept beside the new one: it holds the person's earlier switches, which the new file does not.
        if (settings.warning) {
            renameSync(this.file, `${this.file}.damaged`);
        }

        const temp = `${this.file}.tmp`;

        writeFileSync(
            temp,
            `${JSON.stringify({ disabled: [...settings.disabled].sort(), ...(settings.systemDisabled.size > 0 && { systemDisabled: [...settings.systemDisabled].sort() }) }, null, 4)}\n`
        );
        renameSync(temp, this.file);

        return true;
    }
}
