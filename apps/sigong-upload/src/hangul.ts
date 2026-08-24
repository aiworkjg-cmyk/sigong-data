/**
 * Korean-aware name search for the 시공기사 picker.
 *
 * Field staff type on a phone keypad, so a name has to be findable long before
 * it is fully typed. "홍길동" must match ㅎ, 호, 홍, 홍ㄱ, ㅎㄱㄷ — all of which
 * a plain `includes` misses, because a half-typed syllable ("호") is a
 * different code point from the finished one ("홍").
 *
 * The fix is to compare decomposed jamo rather than syllables.
 */

/** 유니코드 한글 음절 영역: 가(0xAC00) ~ 힣(0xD7A3). */
const SYLLABLE_START = 0xac00;
const SYLLABLE_END = 0xd7a3;

const INITIALS = [
  'ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ',
  'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ',
] as const;

const MEDIALS = [
  'ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ',
  'ㅙ', 'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ',
] as const;

const FINALS = [
  '', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ',
  'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ',
  'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ',
] as const;

const MEDIAL_COUNT = MEDIALS.length; // 21
const FINAL_COUNT = FINALS.length; // 28

function isSyllable(code: number): boolean {
  return code >= SYLLABLE_START && code <= SYLLABLE_END;
}

/** 홍길동 → "ㅎㅗㅇㄱㅣㄹㄷㅗㅇ". Non-Hangul passes through unchanged. */
export function decompose(text: string): string {
  let out = '';

  for (const char of text) {
    const code = char.charCodeAt(0);
    if (!isSyllable(code)) {
      out += char;
      continue;
    }

    const offset = code - SYLLABLE_START;
    out += INITIALS[Math.floor(offset / (MEDIAL_COUNT * FINAL_COUNT))];
    out += MEDIALS[Math.floor(offset / FINAL_COUNT) % MEDIAL_COUNT];
    out += FINALS[offset % FINAL_COUNT];
  }

  return out;
}

/** 홍길동 → "ㅎㄱㄷ". Non-Hangul characters are kept as-is. */
export function initials(text: string): string {
  let out = '';

  for (const char of text) {
    const code = char.charCodeAt(0);
    if (isSyllable(code)) {
      out += INITIALS[Math.floor((code - SYLLABLE_START) / (MEDIAL_COUNT * FINAL_COUNT))];
    } else {
      out += char;
    }
  }

  return out;
}

/** True when every character is a standalone consonant (ㄱ, ㅎ, ...). */
function isInitialsOnly(text: string): boolean {
  return text.length > 0 && [...text].every((char) => INITIALS.includes(char as any));
}

/**
 * Does `name` match what the user has typed so far?
 *
 * A consonants-only query is matched against the name's initials, so "ㅎㄱㄷ"
 * finds 홍길동 without also dragging in every name containing ㅎ mid-word.
 * Anything else is compared as decomposed jamo, which lets a half-typed
 * syllable ("홍ㄱ") match the finished one ("홍길").
 */
export function matchesQuery(name: string, query: string): boolean {
  const needle = query.trim();
  if (!needle) return true;

  // Plain substring first — covers Latin names and exact Hangul.
  if (name.toLowerCase().includes(needle.toLowerCase())) return true;

  if (isInitialsOnly(needle)) {
    return initials(name).includes(needle);
  }

  return decompose(name).includes(decompose(needle));
}
