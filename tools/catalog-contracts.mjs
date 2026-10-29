// Public registry metadata is evidence about ownership, never code to execute.
import { parseYaml } from './pin-github-checks-structure.mjs';

export const organization = 'Particle-Academy';
export const repositoryPattern = /^prism[a-z0-9_.-]*$/i;
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
export const identity = (row) => `${row.registry}:${row.name}`;
export const normalizePythonName = (name) => name.toLowerCase().replace(/[-_.]+/g, '-');

export function repositoryName(value) {
  if (typeof value !== 'string') return null;
  const match = /^https:\/\/github\.com\/Particle-Academy\/(prism[a-z0-9_.-]*?)(?:\.git)?\/?$/i.exec(value.replace(/^git\+/, ''));
  return match?.[1] ?? null;
}

export function ownsRelease(release) {
  const owner = release.ownership ?? {};
  return [owner.author, owner.maintainer].includes('Particle Academy') ||
    (owner.repositories ?? []).some((url) => repositoryName(url) !== null);
}

// A recorded third-party exclusion is tied to the observed identity. If it
// changes hands, the old exclusion cannot quietly hide a first-party release.
function matchesExclusion(row, exclusion) {
  return !ownsRelease(row) && JSON.stringify(row.ownership) === JSON.stringify(exclusion.ownership);
}

export function validateCatalog(manifest, inventory) {
  const failures = [];
  const packages = Object.entries(manifest.packages ?? {});
  if (!packages.length) failures.push('No canonical packages; catalog would assert nothing');
  const identities = new Map(), represented = new Set(), runtimes = new Map(), privateEnvelopes = new Set();
  for (const [key, pkg] of packages) {
    const id = identity(pkg);
    if (identities.has(id)) failures.push(`Duplicate distribution ${id}`);
    identities.set(id, { key, ...pkg });
    if (!['published', 'planned', 'deprecated'].includes(pkg.status)) failures.push(`${key}: invalid status`);
    if (pkg.published !== (pkg.status !== 'planned')) failures.push(`${key}: legacy published flag contradicts status`);
    if (!['public', 'hidden'].includes(pkg.catalog) || pkg.catalog === 'hidden' && !nonempty(pkg.catalog_reason)) failures.push(`${key}: catalog visibility requires a hidden reason`);
    if (pkg.status === 'planned' && pkg.catalog !== 'hidden') failures.push(`${key}: planned distribution must be hidden until published`);
    if (pkg.status === 'planned' ? pkg.version !== null : !nonempty(pkg.version)) failures.push(`${key}: version contradicts publication status`);
    if (!['runtime', 'tooling'].includes(pkg.kind)) failures.push(`${key}: invalid package kind`);
    if (!['php', 'ts', 'py'].includes(pkg.language) || !['packagist', 'npm', 'pypi'].includes(pkg.registry)) failures.push(`${key}: invalid language/registry`);
    if ({ php: 'packagist', ts: 'npm', py: 'pypi' }[pkg.language] !== pkg.registry) failures.push(`${key}: language/registry mismatch`);
    if (!nonempty(pkg.name) || !({npm:/^@particle-academy\/prism[a-z0-9-]*$/,packagist:/^particle-academy\/prism[a-z0-9-]*$/,pypi:/^prism(?:-ai)?-[a-z0-9-]+$/}[pkg.registry]?.test(pkg.name))) failures.push(`${key}: invalid registry name`);
    const repo = repositoryName(pkg.repository);
    if (repo === 'prism.agi') failures.push(`${key}: workspace envelope cannot be a distribution repository`);
    if (repo) represented.add(repo);
    else if (pkg.status !== 'planned' || pkg.repository !== null) failures.push(`${key}: invalid first-party repository`);
    if (pkg.kind === 'runtime') {
      if (!nonempty(pkg.family) || !['reference','port'].includes(pkg.role)) failures.push(`${key}: runtime needs family and role`);
      const familyKey = `${pkg.family}:${pkg.language}`;
      if (runtimes.has(familyKey)) failures.push(`Duplicate runtime ${familyKey}`);
      runtimes.set(familyKey, { key, ...pkg });
    } else if (pkg.role !== 'tooling') failures.push(`${key}: tooling cannot be a runtime reference`);
  }
  for (const [key, project] of Object.entries(manifest.projects ?? {})) {
    const repo = repositoryName(project.repository);
    if (!repo || key !== repo || !['application','tooling','envelope'].includes(project.kind)) failures.push(`${key}: invalid project record`);
    else represented.add(repo);
    if (project.catalog !== 'hidden' || !nonempty(project.catalog_reason)) failures.push(`${key}: non-package project requires hidden reason`);
    if (project.repository_inventory !== undefined) {
      if (key !== 'prism.agi' || project.kind !== 'envelope' || project.repository_inventory !== 'private-envelope' || !nonempty(project.inventory_reason)) failures.push(`${key}: only the documented private workspace envelope may be absent from public inventory`);
      else privateEnvelopes.add(key);
    }
  }
  const liveRepos = new Set((inventory.repositories ?? []).map((row) => row.name));
  if (!liveRepos.size) failures.push('Empty live repository census');
  for (const name of liveRepos) if (!represented.has(name)) failures.push(`UNCLASSIFIED repository ${name}`);
  for (const name of represented) if (!liveRepos.has(name) && !privateEnvelopes.has(name)) failures.push(`Repository lookup missing ${name}`);
  const families = manifest.family_references ?? {};
  for (const pkg of runtimes.values()) {
    const referenceKey = families[pkg.family];
    const reference = manifest.packages?.[referenceKey];
    if (!reference || reference.kind !== 'runtime' || reference.family !== pkg.family || reference.role !== 'reference') failures.push(`${pkg.family}: missing family reference`);
    if (pkg.role === 'reference' && referenceKey !== pkg.key) failures.push(`${pkg.family}: conflicting references`);
  }
  for (const family of Object.keys(families)) if (![...runtimes.values()].some((pkg) => pkg.family === family)) failures.push(`${family}: orphan reference`);
  if (manifest.packages?.[families.acp]?.language !== 'ts') failures.push('ACP reference must be TypeScript');
  // Compatibility views are still consumed by older clients. Their version,
  // publication and identity fields must agree with the canonical records.
  for (const [key, pkg] of Object.entries(manifest.satellites ?? {})) {
    if (key.startsWith('$')) continue;
    for (const field of ['language','registry','name','repository','version','status','published','catalog','catalog_reason']) {
      if (pkg[field] !== manifest.packages?.[key]?.[field]) failures.push(`${key}: stale satellites.${field}`);
    }
  }
  const exclusions = new Map();
  for (const row of manifest.registry_exclusions ?? []) {
    if (exclusions.has(identity(row)) || identities.has(identity(row)) || !nonempty(row.reason) || !/^\d{4}-\d{2}-\d{2}$/.test(row.reviewed_on ?? '') || !row.ownership) failures.push('Invalid reviewed registry exclusion');
    exclusions.set(identity(row), row);
  }
  const releases = new Map();
  for (const row of inventory.releases ?? []) {
    if (releases.has(identity(row))) failures.push(`Duplicate metadata ${identity(row)}`);
    releases.set(identity(row), row);
  }
  let published = 0, planned = 0, excluded = 0;
  for (const [id, pkg] of identities) {
    const release = releases.get(id);
    const endpoint = release?.endpoint ? ` [${release.endpoint}]` : '';
    if (!release || ![200,404].includes(release.http)) { failures.push(`Lookup failed ${id}${endpoint}`); continue; }
    if (pkg.status === 'planned') {
      planned++;
      if (release.http !== 404) failures.push(`${id}: planned package is now published; classify its release${endpoint}`);
      continue;
    }
    published++;
    if (release.http !== 200) { failures.push(`${id}: published package lookup failed${endpoint}`); continue; }
    if (!ownsRelease(release)) failures.push(`UNCLASSIFIED ownership ${id}`);
    const repo = repositoryName(pkg.repository);
    const reported = release.ownership?.repositories ?? [];
    if (pkg.registry !== 'pypi' && !reported.some((url) => repositoryName(url) === repo) ||
        pkg.registry === 'pypi' && reported.some((url) => /github\.com/i.test(url) && repositoryName(url) !== repo)) failures.push(`${id}: registry repository identity mismatch`);
    if (pkg.version !== release.version) failures.push(`${id}: version ${pkg.version} != published ${release.version}${endpoint}`);
    if (Boolean(release.deprecated) !== (pkg.status === 'deprecated')) failures.push(`${id}: deprecation status mismatch`);
    const withinCensus = pkg.registry !== 'pypi' || pkg.name.startsWith('prism-ai-');
    if (withinCensus && !inventory.names?.[pkg.registry]?.includes(pkg.name)) failures.push(`${id}: published distribution missing from registry census`);
  }
  for (const [registry, names] of Object.entries(inventory.names ?? {})) {
    if (!Array.isArray(names) || !names.length || new Set(names).size !== names.length) { failures.push(`${registry}: empty/duplicate live inventory`); continue; }
    for (const name of names) {
      const id = `${registry}:${name}`, row = releases.get(id), pkg = identities.get(id), exclusion = exclusions.get(id);
      if (!row || row.http !== 200) { failures.push(`Live metadata lookup failed ${id}`); continue; }
      if (pkg) continue;
      if (exclusion && matchesExclusion(row, exclusion)) excluded++;
      else failures.push(`UNCLASSIFIED ${ownsRelease(row) ? 'first-party distribution' : 'ownership'} ${id}`);
    }
  }
  for (const registry of ['npm','packagist','pypi']) if (!inventory.names?.[registry]?.length) failures.push(`${registry}: registry was not enumerated`);
  for (const [id, row] of exclusions) {
    const current = releases.get(id);
    if (!current || current.http !== 200 || !matchesExclusion(current, row)) failures.push(`${id}: reviewed exclusion identity changed or lookup failed`);
  }
  return { failures, repositories: liveRepos.size, published, planned, excluded, privateEnvelopes:privateEnvelopes.size };
}

export function familyDrift(pkg, manifest) {
  const family = pkg.family ?? 'core';
  const reference = manifest.packages?.[manifest.family_references?.[family]];
  const kinds = ['capabilities','providers','features'];
  if (!reference || kinds.some((kind) => !Array.isArray(reference.surface?.[kind]) || !Array.isArray(pkg.surface?.[kind]))) return {reference,verified:false,missing:[]};
  const singular = {capabilities:'capability',providers:'provider',features:'feature'};
  const missing = kinds.flatMap((kind) => reference.surface[kind].filter((value) => !pkg.surface[kind].includes(value)).map((value) => `${singular[kind]}:${value}`));
  return {reference,verified:true,missing};
}

export function checkCatalogWorkflow(text) {
  const steps = parseYaml(text)?.jobs?.alignment?.steps ?? [];
  const live = steps.filter((step) => step.run === 'node tools/run-gate.mjs catalog -- node tools/catalog-currency.mjs --check');
  const failures = [];
  if (live.length !== 1 || live[0].if || live[0]['continue-on-error']) failures.push('Live catalog must run unconditionally and fail closed');
  if (live.length === 1 && live[0].env?.GH_TOKEN !== '${{ github.token }}') failures.push('Live catalog requires ordinary read-only workflow token');
  return failures;
}
