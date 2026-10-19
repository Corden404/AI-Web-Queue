import { build } from 'vite';
import { cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const common = { configFile: false, logLevel: 'warn', build: { outDir: 'dist', emptyOutDir: false,
  target: 'chrome120', minify: false, sourcemap: false } };
const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
if (relative(projectRoot, process.cwd())) throw new Error('Run the build from the project directory');
const distPath = join(projectRoot, 'dist');
const trashPath = join(projectRoot, '.trash');
if (dirname(distPath) !== projectRoot || dirname(trashPath) !== projectRoot) throw new Error('Invalid build output path');
await mkdir(trashPath, { recursive: true });
try { await rename(distPath, join(trashPath, `dist-${Date.now()}-${process.pid}`)); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir('dist', { recursive: true });
await build({ ...common, build: { ...common.build, lib: { entry: 'src/content.ts', formats: ['iife'], name: 'ChatGPTWebQueue', fileName: () => 'content.js' } } });
await build({ ...common, build: { ...common.build, lib: { entry: 'src/background.ts', formats: ['es'], fileName: () => 'background.js' } } });
await build({ ...common, build: { ...common.build, lib: { entry: 'src/popup.ts', formats: ['es'], fileName: () => 'popup.js' } } });
await build({ ...common, build: { ...common.build, lib: { entry: 'src/history-page.ts', formats: ['es'], fileName: () => 'history.js' } } });
await build({ ...common, build: { ...common.build, lib: { entry: 'src/options.ts', formats: ['es'], fileName: () => 'options.js' } } });
await build({ ...common, build: { ...common.build, lib: { entry: 'src/page/naming-bridge.ts', formats: ['iife'], name: 'ChatGPTNamingBridge', fileName: () => 'naming-bridge.js' } } });
await cp('public/manifest.json', 'dist/manifest.json');
await cp('public/popup.html', 'dist/popup.html');
await cp('public/history.html', 'dist/history.html');
await cp('public/options.html', 'dist/options.html');
await cp('public/options.css', 'dist/options.css');
await cp('node_modules/@phosphor-icons/core/LICENSE', 'dist/PHOSPHOR-LICENSE.txt');
// A small original code-drawn queue icon, avoiding any external image dependency.
const crc32 = bytes => { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const t = Buffer.from(type); const size = Buffer.alloc(4); size.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([size, t, data, crc]); };
await mkdir('dist/icons', { recursive: true });
for (const size of [16, 48, 128]) {
  const bytes = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * (size * 4 + 1) + 1 + x * 4;
    const nx = x / size, ny = y / size;
    const corner = Math.hypot(Math.max(.19 - nx, nx - .81, 0), Math.max(.19 - ny, ny - .81, 0)) > .17;
    const line = nx > .23 && nx < (ny < .4 ? .77 : ny < .59 ? .64 : .51) &&
      ((ny > .26 && ny < .33) || (ny > .46 && ny < .53) || (ny > .66 && ny < .73));
    bytes[i] = line ? 242 : 43; bytes[i + 1] = line ? 242 : 43; bytes[i + 2] = line ? 242 : 43; bytes[i + 3] = corner ? 0 : 255;
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  await writeFile(`dist/icons/${size}.png`, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(bytes)), chunk('IEND', Buffer.alloc(0))]));
}
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
console.log(`Built ChatGPT Web Queue ${pkg.version} → dist/ (Manifest V3, local assets only)`);
