import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const source=resolve(process.argv[2]??'.tmp/sdk-upstream/packages/plugin-sdk');
const built=resolve('node_modules/@kiki/plugin-sdk');
const expected=JSON.parse(await readFile(resolve(source,'package.json'),'utf8'));
const actual=JSON.parse(await readFile(resolve(built,'package.json'),'utf8'));
assert.equal(expected.name,actual.name);assert.equal(expected.version,actual.version);assert.deepEqual(expected.exports,actual.exports);
for(const file of await readdir(resolve(source,'dist'))){assert.deepEqual(await readFile(resolve(source,'dist',file)),await readFile(resolve(built,'dist',file)),file+' differs from pinned SDK source');}
console.log('SDK tarball matches fixed upstream compiled exports',actual.version);
