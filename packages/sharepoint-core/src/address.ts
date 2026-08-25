/**
 * Korean address parsing for folder names.
 *
 * A submitted address is whatever the field worker typed on a phone — often a
 * full postal address including the unit number. Folders should group by place,
 * not by household, so this pulls out two things and drops the rest:
 *
 *   region    시도 + 시군구, e.g. "경기도광명시"
 *   building  the apartment or building name, e.g. "이편한세상"
 *
 * "경기도 광명시 소하동 이편한세상 101동 1502호"  ->  경기도광명시 / 이편한세상
 *
 * Dropping the unit number is the point: 101동 1502호 and 102동 903호 are the
 * same site visit, and separate folders per household would scatter one job
 * across dozens of directories.
 */

export interface ParsedAddress {
  /** 시도 (경기도, 서울특별시 ...). */
  sido: string;
  /** 시군구, including a nested 구 when present (성남시 분당구). */
  sigungu: string;
  /** sido + sigungu with spaces removed. */
  region: string;
  /** Apartment or building name, empty when the address has none. */
  building: string;
}

const UNSET = '미지정';

/** 시도 — the widest level. Matched loosely: "경기" and "경기도" both count. */
const SIDO = /(특별시|광역시|특별자치시|특별자치도|도)$/;
const SIDO_SHORT = /^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)$/;

/** 시 / 군 / 구 — 성남시 분당구 keeps both. */
const SIGUNGU = /(시|군|구)$/;

/**
 * Parts that are neither region nor building.
 *
 * Order matters only for readability; each is tested independently.
 */
const DROP_PATTERNS: RegExp[] = [
  /^\d+(-\d+)*$/, // 번지: 60, 123-4
  /^[A-Za-z0-9]+동$/, // 동호수: 101동, A동, B동
  /^지하/, // 지하1층, 지하주차장
  /\d+호$/, // 1502호
  /\d+층$/, // 5층
  /^[가-힣]+동$/, // 법정동: 소하동, 하안동 — 시군구보다 아래라 제외
  /(읍|면|리)$/, // 읍면리
  /(로|길)$/, // 도로명: 하안로, 테헤란로, 안양천로
  /^[가-힣]+로\d+(번길)?$/, // 도로명+번호: 하안로60, 중앙로12번길
];

function isDroppable(token: string): boolean {
  return DROP_PATTERNS.some((pattern) => pattern.test(token));
}

/**
 * Splits an address into region and building.
 *
 * Everything the address contains beyond the region and the unit number is
 * treated as the building name, because a field worker writes the landmark they
 * actually navigated to — and that is the most useful thing to see in a folder
 * listing.
 */
export function parseAddress(address: string): ParsedAddress {
  const tokens = (address || '').trim().split(/\s+/).filter(Boolean);

  if (tokens.length === 0) {
    return { sido: UNSET, sigungu: UNSET, region: UNSET, building: '' };
  }

  let index = 0;
  let sido = '';
  let sigungu = '';

  if (SIDO.test(tokens[0]) || SIDO_SHORT.test(tokens[0])) {
    sido = tokens[index];
    index += 1;
  }

  // 시 then an optional nested 구 — 경기도 성남시 분당구.
  while (index < tokens.length && SIGUNGU.test(tokens[index])) {
    sigungu = sigungu ? `${sigungu} ${tokens[index]}` : tokens[index];
    index += 1;
    // Only a 시 can be followed by a 구; stop otherwise.
    if (!/시$/.test(tokens[index - 1])) break;
  }

  const building = tokens
    .slice(index)
    .filter((token) => !isDroppable(token))
    .join(' ')
    .trim();

  return {
    sido: sido || UNSET,
    sigungu: sigungu || UNSET,
    region: `${sido}${sigungu}`.replace(/\s+/g, '') || UNSET,
    building,
  };
}
