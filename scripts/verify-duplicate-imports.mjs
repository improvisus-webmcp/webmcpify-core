import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,symlink,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {removeDuplicateImports} from '../dist/lib/duplicate-imports.js';
const root=await mkdtemp(path.join(os.tmpdir(),'webmcpify-duplicate-imports-'));
const external=await mkdtemp(path.join(os.tmpdir(),'webmcpify-import-owner-'));
try {
  const source="import { products, type ProductId } from './products';\nimport { isProductId, products, type ProductId } from './products';\nexport const existing = products;\n";
  await writeFile(path.join(root,'app.tsx'),source);
  await writeFile(path.join(root,'untouched.tsx'),source);
  assert.equal(await removeDuplicateImports(root,['app.tsx']),1);
  assert.equal(await readFile(path.join(root,'app.tsx'),'utf8'),"import { products, type ProductId } from './products';\nimport { isProductId } from './products';\nexport const existing = products;\n");
  assert.equal(await readFile(path.join(root,'untouched.tsx'),'utf8'),source);
  assert.equal(await removeDuplicateImports(root,['app.tsx']),0);
  const conflict="import { products } from './one';\nimport { products } from './two';\n";
  await writeFile(path.join(root,'conflict.js'),conflict);
  assert.equal(await removeDuplicateImports(root,['conflict.js']),0);
  assert.equal(await readFile(path.join(root,'conflict.js'),'utf8'),conflict);
  const comments="import { products } from './products';\nimport { /* retain */ products } from './products';\n";
  await writeFile(path.join(root,'comments.js'),comments);
  assert.equal(await removeDuplicateImports(root,['comments.js']),0);
  await writeFile(path.join(external,'owner.tsx'),source);
  if(process.platform!=='win32'){
    await symlink(path.join(external,'owner.tsx'),path.join(root,'linked.tsx'));
    assert.equal(await removeDuplicateImports(root,['linked.tsx']),0);
  }
  assert.equal(await removeDuplicateImports(root,[path.join(external,'owner.tsx')]),0);
  assert.equal(await readFile(path.join(external,'owner.tsx'),'utf8'),source);
}finally{await rm(root,{recursive:true,force:true});await rm(external,{recursive:true,force:true});}
console.log('Duplicate import cleanup passed: exact named/type duplicates, unchanged declarations, conflicts, comments, idempotence and workspace confinement.');
