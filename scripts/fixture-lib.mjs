// Development fixtures copy an explicit input allowlist, never generated state.
import { cp, copyFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultSource = fileURLToPath(new URL('../tests/fixtures/multi-chain/', import.meta.url));
export async function copyFixture(destination, source = defaultSource) {
  await mkdir(destination, { recursive: true });
  await cp(resolve(source, 'src'), resolve(destination, 'src'), { recursive: true });
  await copyFile(resolve(source, 'atlas.json'), resolve(destination, 'atlas.json'));
}
