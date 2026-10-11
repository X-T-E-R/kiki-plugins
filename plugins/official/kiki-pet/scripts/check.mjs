import assert from 'node:assert/strict';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {packageFiles} from '../../../../scripts/package-files.mjs';
import {tools} from '../lib/definitions.mjs';
import {register} from '../entry.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const manifest=JSON.parse(await readFile(path.join(root,'kimi.plugin.json'),'utf8'));
assert.equal(manifest.name,'kiki-pet');assert.equal(manifest.license,'GPL-3.0-or-later');assert.equal(manifest['x-kiki'].activation,'app');assert.deepEqual(manifest['x-kiki'].tools,tools);
const files=await packageFiles(root),registered=[];
register({registerTool(definition,execute){assert.equal(typeof execute,'function');registered.push(definition);}});assert.deepEqual(registered,tools);
for(const required of ['entry.mjs','LICENSE','README.md','THIRD_PARTY_NOTICES.md','vendor/runtime-source/Cargo.lock','vendor/runtime-source/LICENSE','vendor/runtime-source/src/main.rs','vendor/runtime-source/ui/pet.mjs','lib/assets/momo/spritesheet.webp','skills/kiki-pet-maker/NOTICE'])assert.ok(files.includes(required),required+' missing from distributable');
for(const panel of manifest['x-kiki'].panels){for(const name of [panel.path,...panel.assets])assert.ok(files.includes(name.replace(/^\.\//,'')),'Declared panel resource missing: '+name);}
for(const file of ['index.html','panel.js','style.css'])assert.deepEqual(await readFile(path.join(root,'panel',file)),await readFile(path.join(root,'lib/panel',file)));
for(const file of ['index.html','pet.mjs','style.css'])assert.deepEqual(await readFile(path.join(root,'runtime/ui',file)),await readFile(path.join(root,'vendor/runtime-source/ui',file)));
assert.ok(!files.some(file=>file.endsWith('panel.mjs')),'Obsolete panel artifact');
const executable=path.join(root,'vendor/runtime/win32-x64/kiki-pet-runtime.exe');assert.ok((await stat(executable)).size>1000000);
console.log(JSON.stringify({plugin:manifest.name,version:manifest.version,packagedFiles:files.length,tools:registered.length,sourceCopiesEqual:true,windowsRuntime:true}));
