import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Child CLI processes inherit this, so tests never read or write the real per-user settings.
process.env.MEDIA_RENAMER_CONFIG_DIR = mkdtempSync(path.join(os.tmpdir(), 'mr-test-config-'));
for (const name of Object.keys(process.env)) {
  if (name.startsWith('MEDIA_RENAMER_') && name !== 'MEDIA_RENAMER_CONFIG_DIR') delete process.env[name];
}
