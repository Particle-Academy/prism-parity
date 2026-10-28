import { createHash } from 'node:crypto';
import { identity, normalizePythonName, organization, repositoryPattern } from './catalog-contracts.mjs';

const userAgent = 'prism-parity-catalog/1.0 (+https://github.com/Particle-Academy/prism-parity/issues)';
// Fixed origins, bounded responses, no redirects and no remote code execution.
export async function requestJson(url, { githubToken, pythonIndex = false, fetchImpl = fetch } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password || target.port || !['api.github.com','replicate.npmjs.com','registry.npmjs.org','packagist.org','pypi.org'].includes(target.hostname)) throw Error('Unapproved inventory origin');
  const headers = { 'User-Agent': userAgent, 'Cache-Control': 'no-cache' };
  if (pythonIndex) headers.Accept = 'application/vnd.pypi.simple.v1+json';
  if (githubToken && target.hostname === 'api.github.com') headers.Authorization = `Bearer ${githubToken}`;
  let response;
  try { response = await fetchImpl(target, { headers, redirect: 'error', signal: AbortSignal.timeout(60_000) }); }
  catch { throw Error(`Inventory request failed: ${target.hostname}${target.pathname}`); }
  if (response.status === 404) return { http: 404 };
  if (response.status !== 200) throw Error(`Inventory lookup HTTP${response.status}: ${target.hostname}${target.pathname}`);
  const chunks = [], limit = pythonIndex ? 128 * 1024 * 1024 : 16 * 1024 * 1024;
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > limit) throw Error('Response exceeds inventory size bound');
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks);
    return { http: 200, body: JSON.parse(raw.toString('utf8')), bytes, sha256: createHash('sha256').update(raw).digest('hex'), serial: response.headers.get('x-pypi-last-serial') };
  } catch { throw Error(`Invalid or oversized inventory response: ${target.hostname}${target.pathname}`); }
}

function requireBody(response, source) {
  if (response?.http !== 200 || !response.body) throw Error(`${source}: inventory lookup failed`);
  return response.body;
}

export async function discoverRepositories(request) {
  const repos = new Map();
  for (let page = 1; page <= 100; page++) {
    const batch = requireBody(await request(`https://api.github.com/orgs/${organization}/repos?type=all&per_page=100&page=${page}`), 'GitHub');
    if (!Array.isArray(batch) || batch.length > 100) throw Error('Malformed organization page');
    for (const row of batch) {
      if (!repositoryPattern.test(row?.name ?? '')) continue;
      if (row.full_name !== `${organization}/${row.name}` || !row.default_branch || repos.has(row.name)) throw Error('Duplicate or invalid repository identity');
      repos.set(row.name, { name: row.name, archived: row.archived, defaultBranch: row.default_branch });
    }
    if (batch.length < 100) {
      if (!repos.size) throw Error('Empty repository census');
      return [...repos.values()].sort((a,b) => a.name.localeCompare(b.name));
    }
  }
  throw Error('Incomplete organization pagination');
}

export async function discoverNpm(request) {
  const prefix = '@particle-academy/prism', names = [], pages = [];
  let cursor = prefix;
  // Current replication API: no deprecated skip or include_docs parameters.
  for (let page = 0; page < 100; page++) {
    const url = new URL('https://replicate.npmjs.com/registry/_all_docs');
    url.searchParams.set('startkey', JSON.stringify(cursor));
    url.searchParams.set('endkey', JSON.stringify(`${prefix}\ufff0`));
    url.searchParams.set('limit', '251');
    const response = await request(url.href), { rows } = requireBody(response, 'npm');
    if (!Array.isArray(rows) || rows.length > 251) throw Error('Malformed npm inventory page');
    pages.push({ rows: rows.length, sha256: response.sha256 });
    for (const [index, row] of rows.entries()) {
      const name = row.id;
      if (typeof name !== 'string' || !name.startsWith(prefix)) throw Error('Invalid npm inventory identity');
      if (page > 0 && index === 0 && name === cursor) continue;
      if (name < cursor || names.length && name <= names.at(-1)) throw Error('Duplicate or unordered npm inventory');
      names.push(name);
    }
    if (rows.length < 251) {
      if (!names.length) throw Error('Empty npm inventory');
      return { names, pages };
    }
    if (!names.length || names.at(-1) <= cursor) throw Error('Nonadvancing npm inventory');
    cursor = names.at(-1);
  }
  throw Error('Incomplete npm pagination');
}

export async function discoverPackagist(request) {
  const response = await request('https://packagist.org/packages/list.json?vendor=particle-academy');
  const list = requireBody(response, 'Packagist').packageNames;
  if (!Array.isArray(list) || list.some((name) => typeof name !== 'string')) throw Error('Malformed Packagist inventory');
  const names = list.filter((name) => name.startsWith('particle-academy/prism')).sort();
  if (!names.length || new Set(names).size !== names.length) throw Error('Empty or duplicate Packagist inventory');
  return { names, vendorPackages: list.length, sha256: response.sha256 };
}

export async function discoverPython(request) {
  const response = await request('https://pypi.org/simple/', { pythonIndex: true });
  const body = requireBody(response, 'PyPI'), serial = Number(response.serial);
  if (!Array.isArray(body.projects) || !body.projects.length || !Number.isSafeInteger(serial) || serial <= 0 || body.meta?.['_last-serial'] !== serial) throw Error('Malformed or incomplete PyPI Simple index');
  const names = [];
  for (const project of body.projects) {
    if (typeof project.name !== 'string' || !project.name) throw Error('Invalid PyPI project identity');
    const name = normalizePythonName(project.name);
    if (name.startsWith('prism-ai-')) names.push(name);
  }
  names.sort();
  if (!names.length || new Set(names).size !== names.length) throw Error('Empty or duplicate PyPI inventory');
  return { names, projectsScanned: body.projects.length, serial, sha256: response.sha256 };
}

export function composerRank(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)(?:-(dev|alpha|beta|RC)(\d*)?)?$/i.exec(version ?? '');
  return match ? [...match.slice(1,5).map(Number), match[5] ? {dev:0,alpha:1,beta:2,rc:3}[match[5].toLowerCase()] : 4, Number(match[6] || 0)] : null;
}
const compare = (a,b) => { for (let i=0;i<a.length;i++) if (a[i] !== b[i]) return a[i]-b[i]; return 0; };
const repositoryUrls = (repository) => {
  const value = typeof repository === 'string' ? repository : repository?.url;
  return typeof value === 'string' && value ? [value] : [];
};

export function parseRelease(registry, name, response) {
  if (response?.http === 404) return { registry, name, http:404 };
  const body = requireBody(response, `${registry}:${name}`);
  if (registry === 'npm') {
    const version = body['dist-tags']?.latest, release = body.versions?.[version];
    if (body.name !== name || release?.name !== name || release.version !== version || typeof version !== 'string' || !version) throw Error('Malformed npm release identity');
    return {registry,name,http:200,version,deprecated:Boolean(release.deprecated),ownership:{repositories:repositoryUrls(release.repository ?? body.repository)}};
  }
  if (registry === 'packagist') {
    if (body.package?.name !== name || !body.package.versions || typeof body.package.versions !== 'object') throw Error('Malformed Packagist identity');
    const versions = Object.values(body.package.versions).map((release) => {
      const rank = composerRank(release.version_normalized);
      if (!rank && !/^dev-|(?:^|-)dev$/i.test(release.version_normalized ?? '')) throw Error('Unrecognized released Packagist version');
      return {release,rank};
    }).filter((row) => row.rank && row.rank[4] !== 0);
    const stable = versions.filter((row) => row.rank[4] === 4);
    const release = (stable.length ? stable : versions).sort((a,b) => compare(b.rank,a.rank))[0]?.release;
    if (!release || typeof release.version !== 'string' || !release.version) throw Error('No released Packagist version');
    return {registry,name,http:200,version:release.version.replace(/^v/,''),deprecated:Boolean(body.package.abandoned),ownership:{repositories:repositoryUrls(body.package.repository)}};
  }
  const info = body.info;
  if (typeof info?.name !== 'string' || normalizePythonName(info.name) !== name || typeof info.version !== 'string' || !info.version || !Array.isArray(body.urls) || !body.urls.length || body.urls.every((file) => file.yanked !== false)) throw Error('Malformed or fully yanked PyPI release');
  if (info.project_urls !== null && (typeof info.project_urls !== 'object' || Array.isArray(info.project_urls))) throw Error('Malformed PyPI ownership metadata');
  return {registry,name,http:200,version:info.version,deprecated:false,ownership:{author:info.author??null,author_email:info.author_email??null,maintainer:info.maintainer??null,maintainer_email:info.maintainer_email??null,repositories:Object.values(info.project_urls??{}).sort()}};
}

export async function collectCatalog(manifest, request = requestJson) {
  const [repositories,npm,packagist,pypi] = await Promise.all([discoverRepositories(request),discoverNpm(request),discoverPackagist(request),discoverPython(request)]);
  const names = {npm:npm.names,packagist:packagist.names,pypi:pypi.names};
  const lookups = new Map();
  for (const [registry, list] of Object.entries(names)) for (const name of list) lookups.set(`${registry}:${name}`,{registry,name});
  for (const row of [...Object.values(manifest.packages??{}),...(manifest.registry_exclusions??[])]) {
    if (!['npm','packagist','pypi'].includes(row.registry) || typeof row.name !== 'string' || !/^[a-z0-9@/_.-]+$/.test(row.name)) throw Error('Invalid configured registry identity');
    lookups.set(identity(row),{registry:row.registry,name:row.name});
  }
  const rows = [...lookups.values()], releases = [];
  let cursor = 0;
  // Below Packagist's ten concurrent API request limit.
  await Promise.all(Array.from({length:6},async () => {
    for (;;) {
      const index = cursor++;
      if (index >= rows.length) return;
      const {registry,name} = rows[index];
      const url = registry === 'npm' ? `https://registry.npmjs.org/${encodeURIComponent(name)}` : registry === 'packagist' ? `https://packagist.org/packages/${name}.json` : `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;
      releases[index] = parseRelease(registry,name,await request(url));
    }
  }));
  return {at:new Date().toISOString(),repositories,names,releases,evidence:{npm,packagist,pypi}};
}
