// Copies the built app and installer into desktop/release after `tauri build`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(desktop, 'src-tauri', 'target', 'release');
const out = path.join(desktop, 'release');
const { version } = JSON.parse(fs.readFileSync(path.join(desktop, 'src-tauri', 'tauri.conf.json'), 'utf8'));

const files = [
  [path.join(target, 'musicplayer-desktop.exe'), 'Musicplayer.exe'],
  [path.join(target, 'bundle', 'nsis', `Musicplayer_${version}_x64-setup.exe`), `Musicplayer_${version}_x64-setup.exe`],
];

fs.mkdirSync(out, { recursive: true });
for (const [from, name] of files) {
  if (!fs.existsSync(from)) {
    console.error(`Missing ${from}; did the build succeed?`);
    process.exit(1);
  }
  fs.copyFileSync(from, path.join(out, name));
  console.log(`release/${name}`);
}
