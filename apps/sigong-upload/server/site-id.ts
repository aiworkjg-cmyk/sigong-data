import type { SettingsRepository } from './repositories';

/**
 * Readable, sequential submission ids: BAEKJO-20260824-001.
 *
 * The previous form (SITE-20260824-9F3A1C) was unguessable but told nobody
 * anything. Field staff read these ids over the phone, so the id now carries
 * the 시공종류 and the 시공일 it belongs to, and counts up within that pair.
 *
 * The date is the 시공일, not the submission time, so the id lines up with the
 * folder the files are filed under.
 */

const SEQUENCE_KEY = 'siteSequence';
/** Counters older than this are dropped; they can never be reused anyway. */
const KEEP_DAYS = 120;
const MAX_CODE_LENGTH = 12;

/* ------------------------------------------------------------------ */
/* Hangul romanization                                                 */
/* ------------------------------------------------------------------ */

const SYLLABLE_START = 0xac00;
const SYLLABLE_END = 0xd7a3;

// Revised Romanization of Korean, by jamo position.
const INITIAL_ROMAN = [
  'G', 'KK', 'N', 'D', 'TT', 'R', 'M', 'B', 'PP', 'S',
  'SS', '', 'J', 'JJ', 'CH', 'K', 'T', 'P', 'H',
];

const MEDIAL_ROMAN = [
  'A', 'AE', 'YA', 'YAE', 'EO', 'E', 'YEO', 'YE', 'O', 'WA',
  'WAE', 'OE', 'YO', 'U', 'WO', 'WE', 'WI', 'YU', 'EU', 'UI', 'I',
];

const FINAL_ROMAN = [
  '', 'K', 'K', 'K', 'N', 'N', 'N', 'T', 'L', 'K',
  'M', 'P', 'T', 'T', 'P', 'L', 'M', 'P', 'P', 'T',
  'T', 'NG', 'T', 'T', 'K', 'T', 'P', 'T',
];

/**
 * 백조 -> BAEKJO. Latin characters and digits already present are kept, and
 * anything else (spaces, punctuation) is dropped, so the result is always safe
 * inside an id.
 */
export function romanize(name: string): string {
  let out = '';

  for (const char of name) {
    const code = char.charCodeAt(0);

    if (code >= SYLLABLE_START && code <= SYLLABLE_END) {
      const offset = code - SYLLABLE_START;
      out += INITIAL_ROMAN[Math.floor(offset / 588)];
      out += MEDIAL_ROMAN[Math.floor(offset / 28) % 21];
      out += FINAL_ROMAN[offset % 28];
    } else if (/[A-Za-z0-9]/.test(char)) {
      out += char.toUpperCase();
    }
  }

  return out.slice(0, MAX_CODE_LENGTH) || 'ETC';
}

/* ------------------------------------------------------------------ */
/* Sequence                                                            */
/* ------------------------------------------------------------------ */

type Counters = Record<string, number>;

export class SiteIdFactory {
  private counters: Counters = {};
  /** Serializes allocation so two submissions cannot claim the same number. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly repo: SettingsRepository) {}

  async load(): Promise<void> {
    this.counters = prune(parseCounters(await this.repo.get(SEQUENCE_KEY)));
  }

  /**
   * Allocates the next id for this 시공종류 / 시공일 pair.
   *
   * `exists` is consulted so a counter lost to a wiped store cannot hand out an
   * id that is already taken — it walks forward until the id is free.
   */
  async next(
    constructionType: string,
    constructionDate: string,
    exists: (id: string) => Promise<boolean>
  ): Promise<string> {
    const run = this.queue.then(() => this.allocate(constructionType, constructionDate, exists));
    // Keep the chain alive even if this allocation throws.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async allocate(
    constructionType: string,
    constructionDate: string,
    exists: (id: string) => Promise<boolean>
  ): Promise<string> {
    const code = romanize(constructionType);
    const datePart = constructionDate.replace(/-/g, '');
    const key = `${code}-${datePart}`;

    let sequence = (this.counters[key] ?? 0) + 1;
    let id = format(key, sequence);

    // Bounded so a persistent lookup failure cannot spin forever.
    for (let attempt = 0; attempt < 50 && (await exists(id)); attempt += 1) {
      sequence += 1;
      id = format(key, sequence);
    }

    this.counters[key] = sequence;
    this.counters = prune(this.counters);
    // Best-effort: a failed counter write costs a duplicate check next time,
    // not a duplicate id, because `exists` still guards the result.
    await this.repo
      .set(SEQUENCE_KEY, JSON.stringify(this.counters))
      .catch((err) => console.error('[site-id] 순번 저장 실패', err));

    return id;
  }
}

function format(key: string, sequence: number): string {
  return `${key}-${String(sequence).padStart(3, '0')}`;
}

function parseCounters(raw: string | null): Counters {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const counters: Counters = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        counters[key] = Math.floor(value);
      }
    }
    return counters;
  } catch {
    return {};
  }
}

/** Drops counters for dates far enough in the past to never be reused. */
function prune(counters: Counters): Counters {
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86400_000);
  const limit = Number(
    `${cutoff.getFullYear()}${String(cutoff.getMonth() + 1).padStart(2, '0')}${String(cutoff.getDate()).padStart(2, '0')}`
  );

  const kept: Counters = {};
  for (const [key, value] of Object.entries(counters)) {
    const datePart = Number(key.slice(key.lastIndexOf('-') + 1));
    if (!Number.isFinite(datePart) || datePart >= limit) kept[key] = value;
  }
  return kept;
}
