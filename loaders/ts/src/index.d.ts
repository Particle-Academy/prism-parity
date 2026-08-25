export type Language = 'php' | 'ts' | 'py';

export const LANGUAGES: readonly Language[];

export class CorpusError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export interface Expectation {
  body_json?: string;
  result_json?: string;
  serialized_json?: string;
  rehydrates?: boolean;
  error_code?: string;
}

export interface BuilderStep {
  call: string;
  args?: unknown[];
}

export interface ConformanceCase {
  id: string;
  title: string;
  /** The corpus version this case was added in. */
  since: string;
  /** What this case exists to catch. Mandatory: a case without a stated purpose gets deleted by someone later. */
  notes: string;
  builder?: BuilderStep[];
  response?: unknown;
  subject?: Record<string, unknown>;
  expect: Expectation;
  /**
   * Opt-in, per-row, and visible in the row it applies to. Absent means EXACT
   * comparison, which covers every case in the corpus today.
   */
  tolerance?: number;
  /** A MAP keyed by language, never a scalar. Reasons are mandatory and non-empty. */
  skip?: Partial<Record<Language, string>>;
}

export interface ResolvedCase extends ConformanceCase {
  skipped: boolean;
  skipReason: string | null;
}

export interface SuiteManifest {
  id: string;
  title: string;
  kind: 'request-payload' | 'response-parse' | 'roundtrip' | 'error-code';
  pins: string;
  pattern_doc?: string;
  reference: Language;
  comparison: { mode: 'canonical-json-string' };
  discrimination?: { status: 'probed' | 'unprobed'; gap?: string };
  implementations: Record<string, { status: 'full' | 'partial' | 'absent'; gap?: string; runner?: string }>;
}

export interface Probe {
  id: string;
  kind: 'control' | 'mutant';
  summary: string;
  hazard: string;
  scope?: string;
  languages: Language[];
  must_fail: Record<string, string[]>;
}

export class Suite {
  readonly id: string;
  readonly manifest: SuiteManifest;
  cases(language: Language): ResolvedCase[];
  skippedIds(language: Language): string[];
}

export class Corpus {
  readonly root: string;
  readonly version: string;
  static open(root?: string): Corpus;
  suiteIds(): string[];
  suite(id: string): Suite;
  /** A content hash of every shipped fixture: `sha256:` followed by 64 lowercase hex characters. */
  digest(): string;
  probes(): { documentation: string; probes: Probe[] };
  expectedProbeFailures(probeId: string, language: Language): Record<string, string[]>;
}

export function compare(expected: string, actual: string, tolerance?: number): boolean;
export function discoverRoot(from?: string): string;
