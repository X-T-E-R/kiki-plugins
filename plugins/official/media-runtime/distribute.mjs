import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const normalize = (text) => text.replaceAll('\r\n', '\n');
const vendors = ['openai', 'google', 'ark', 'xai', 'minimax', 'stepfun', 'novita', 'agnes', 'newapi', 'comfyui'];
const root = new URL('../', import.meta.url);
const expected = normalize(`// GENERATED from ../media-runtime/runtime.mjs. Run media-runtime/distribute.mjs; do not edit this copy.\n${await readFile(
  new URL('./runtime.mjs', import.meta.url),
  'utf8'
)}`);
for (const vendor of vendors) {
  for (const name of ['runtime.mjs', 'entry.mjs', 'LICENSE', 'NOTICE']) {
    const content = name === 'runtime.mjs' ? expected : normalize(await readFile(new URL(`./${name}`, import.meta.url), 'utf8'));
    const destination = new URL(`kiki-media-${vendor}/${name}`, root);
    if (process.argv.includes('--check')) {
      if (normalize(await readFile(destination, 'utf8')) !== content)
        throw new Error(`Generated package drift: ${fileURLToPath(destination)}`);
    } else await writeFile(destination, content);
  }
}
console.log(
  `${process.argv.includes('--check') ? 'Checked' : 'Distributed'} runtime for ${
    vendors.length
  } self-contained provider packages`
);
