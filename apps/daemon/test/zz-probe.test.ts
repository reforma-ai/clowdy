import { afterAll, afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';

import { cleanTempDirs, Harness, startHarness, tempDir } from './helpers';
import { writeSkill } from './skill-helpers';

afterAll(cleanTempDirs);
const harnesses: Harness[] = [];

afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
        await harness.stop();
    }
});

test('probe: a root that appears after start reaches the engines', async () => {
    const root = join(tempDir(), 'later');
    const h = await startHarness({ userSkillRoots: [root] });

    harnesses.push(h);
    writeSkill(root, 'deploy');

    const catalog = await (await h.fetch('/v1/skills')).json() as { entries: { name: string; enabled: boolean }[] };

    expect(catalog.entries.find(entry => entry.name === 'user:deploy')?.enabled).toBe(true);
    await Bun.sleep(1000);
    expect(h.config.extraPluginDirs).toHaveLength(1);
});
