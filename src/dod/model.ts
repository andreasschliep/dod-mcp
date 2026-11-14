/**
 * The Definition of Done as the server sees it after loading and validating the files
 * (design section 5). Everything carries its location, so findings and errors can name
 * file and line.
 */

export type CheckKind = 'evidence' | 'judgment' | 'attestation';
export const CHECK_KINDS: readonly CheckKind[] = ['evidence', 'judgment', 'attestation'];

export type RuleKind =
  'gherkin' | 'observable_then' | 'vague_words' | 'numbers_need_units' | 'fields';
export const RULE_KINDS: readonly RuleKind[] = [
  'gherkin',
  'observable_then',
  'vague_words',
  'numbers_need_units',
  'fields',
];

export type Scalar = string | number | boolean;

export interface Location {
  file: string;
  line: number;
  column: number;
}

export type ValidationCode =
  | 'yaml_syntax'
  | 'missing_key'
  | 'unknown_key'
  | 'invalid_value'
  | 'base_criterion_overridden'
  | 'base_criterion_removed'
  | 'duplicate_id'
  | 'type_name_mismatch'
  | 'invalid_mapping'
  | 'version_not_bumped'
  | 'version_regressed';

export interface ValidationError extends Location {
  code: ValidationCode;
  message: string;
  /** For collisions: the location of the original, usually in base.yaml. */
  related?: Location;
}

/** Exactly one operator per criterion (design section 5.3). */
export interface Expect {
  field?: string;
  equals?: Scalar;
  one_of?: Scalar[];
  min?: number;
  max?: number;
  present?: true;
  not_after?: string;
}

interface CriterionCommon {
  id: string;
  text: string;
  fetch_with?: string[];
  at: Location;
}

export interface EvidenceCriterion extends CriterionCommon {
  check: 'evidence';
  source: string;
  expect: Expect;
  max_age_hours?: number;
  same_ref?: boolean;
}

export interface JudgmentCriterion extends CriterionCommon {
  check: 'judgment';
  question: string;
  plausible_if?: string[];
  doubtful_if?: string[];
}

export interface AttestationCriterion extends CriterionCommon {
  check: 'attestation';
  role: string;
  max_age_hours?: number;
}

export type Criterion = EvidenceCriterion | JudgmentCriterion | AttestationCriterion;

export type FieldFormat = 'date' | 'duration' | 'date_or_duration';

export interface FieldSpec {
  name: string;
  list?: boolean;
  min_items?: number;
  format?: FieldFormat;
}

export type RuleParams =
  | { kind: 'gherkin' }
  | { kind: 'observable_then'; phrases: string[] }
  | { kind: 'vague_words'; words: string[] }
  | { kind: 'numbers_need_units'; units: string[] }
  | { kind: 'fields'; fields: FieldSpec[] };

export type Rule = RuleParams & { id: string; at: Location };

export interface DodFile {
  file: string;
  kind: 'base' | 'type';
  /** "base" or the type name (= file name without .yaml). */
  name: string;
  version: number;
  title: string;
  description?: string;
  criteria: Criterion[];
  rules: Rule[];
  template?: string;
  /** The file text, as read. */
  text: string;
  /** The parsed content, for the normalised hash of a version. */
  data: unknown;
}

export interface MappingEntry {
  type: string;
  ticket_types: string[];
  labels: string[];
  at: Location;
}

export interface MappingFile {
  file: string;
  version: number;
  entries: MappingEntry[];
  text: string;
  data: unknown;
}

/** A file and what came of it: the parsed content if valid, otherwise the errors. */
export interface FileState<T> {
  file: string;
  parsed: T | null;
  errors: ValidationError[];
}

export interface DodSet {
  /** The folder, for messages; results show file names only. */
  dir: string;
  base: FileState<DodFile>;
  mapping: FileState<MappingFile>;
  /** Every type file in the folder, valid or not, by type name, sorted. */
  types: Map<string, FileState<DodFile>>;
}
