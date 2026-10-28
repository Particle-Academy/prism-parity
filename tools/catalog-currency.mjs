#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { collectCatalog, requestJson } from './catalog-registry.mjs';
import { validateCatalog } from './catalog-contracts.mjs';

try {
  if (process.argv.slice(2).join(' ') !== '--check') throw Error('Usage: node tools/catalog-currency.mjs --check');
  // CI supplies its ordinary read-only token. Local checks can use `gh`'s
  // native login; Prism never reads or copies its credential store.
  const request = async (url, options) => {
    if (url.startsWith('https://api.github.com/') && !process.env.GH_TOKEN) {
      const { spawnSync } = await import('node:child_process');
      const result = spawnSync(process.platform === 'win32' ? 'gh.exe' : 'gh', ['api', url.slice('https://api.github.com/'.length)], {encoding:'utf8',timeout:60_000,maxBuffer:16*1024*1024,windowsHide:true});
      if (result.error || result.status !== 0) throw Error('GitHub inventory lookup failed');
      try { return {http:200,body:JSON.parse(result.stdout)}; } catch { throw Error('Malformed GitHub inventory'); }
    }
    return requestJson(url,{...options,githubToken:process.env.GH_TOKEN});
  };
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../manifest/packages.json',import.meta.url)),'utf8'));
  const result = validateCatalog(manifest,await collectCatalog(manifest,request));
  if (result.failures.length) throw Error(result.failures.join('\n'));
  console.log(`Catalog currency passed: ${result.repositories} visible repositories, ${result.published} published distributions, ${result.planned} planned distributions, ${result.excluded} reviewed exclusions, ${result.privateEnvelopes} declared private envelopes; 0 unclassified, 0 unchecked public repositories.`);
} catch (error) {
  console.error(`Catalog currency failed:\n${error.message}`);
  process.exitCode = 1;
}
