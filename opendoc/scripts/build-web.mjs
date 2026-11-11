// Deterministic local-only browser bundle. Original MIT build wrapper.
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = await build({ absWorkingDir: root, entryPoints: ['web/editor.mjs'], outfile: 'web/dist/editor.mjs',
  bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], minify: false,
  legalComments: 'none', sourcemap: false, write: false, charset: 'utf8',
  plugins: [{ name: 'memory-only-configuration', setup(builder) {
    builder.onResolve({ filter: /(?:^|\/)storage(?:\.js)?$/ }, args => {
      if (args.importer.includes(`${path.sep}lib0${path.sep}`)) return { path: path.join(root, 'scripts/browser-memory-storage.mjs') };
    });
  } }] });
const notices = ['OpenDoc browser bundle: original application code is MIT.\nThird-party components follow.\n'];
for (const [name, file] of [['yjs','LICENSE'], ['lib0','LICENSE'], ['isomorphic.js','LICENSE']]) {
  const metadata = JSON.parse(await readFile(path.join(root, 'node_modules', name, 'package.json'), 'utf8'));
  notices.push(`\n${name} ${metadata.version}\n${await readFile(path.join(root, 'node_modules', name, file), 'utf8')}`);
}
const files = [[path.join(root, 'web/dist/editor.mjs'), output.outputFiles[0].text],
  [path.join(root, 'web/dist/THIRD-PARTY-NOTICES.txt'), notices.join('')]];
const bundled = files[0][1];
if (/localStorage|sessionStorage|indexedDB|document\.cookie|https?:\/\/(?:cdn|fonts\.)/.test(bundled)) throw new Error('Browser persistence or external assets found in bundle');
if (process.argv.includes('--check')) {
  for (const [file, content] of files) if (await readFile(file, 'utf8') !== content) throw new Error(`Stale browser asset: ${path.basename(file)}; run npm run build:web`);
  process.stdout.write('Browser bundle and notices match sources.\n');
} else {
  await mkdir(path.join(root, 'web/dist'), { recursive: true });
  for (const [file, content] of files) await writeFile(file, content);
  process.stdout.write('Built local browser bundle and third-party notices.\n');
}
