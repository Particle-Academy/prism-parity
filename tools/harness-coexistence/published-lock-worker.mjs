import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const spec = JSON.parse(fs.readFileSync(process.argv[2]));
const pkg = await import(pathToFileURL(spec.package + '/dist/index.js'));
const store = new pkg.FileSessionStore(spec.store);
let callbacks = 0, failure = null;
try { await store.withLock(spec.key, () => { callbacks++; }, 1, 0); }
catch (error) { failure = { class: error.constructor.name, code: error.code ?? null, message: error.message }; }
console.log(JSON.stringify({ callbacks, failure }));
