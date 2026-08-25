/**
 * Korean address parsing for folder names.
 *
 * A submitted address is whatever the field worker typed on a phone. Folders
 * should group by place, not by household, so this pulls out:
 *
 *   region    시도 + 시군구, e.g. "경기도광명시"
 *   dong      읍/면/동/리, e.g. "소하동"
 *   building  the apartment or building name, e.g. "이편한세상"
 *
 * Dropping the unit number is the point: 107동 1402호 and 102동 903호 are the
 * same site visit, and separate folders per household would scatter one job
 * across dozens of directories.
 *
 * Spacing is ignored entirely. Korean addresses are very often typed with no
 * spaces at all ("경기도광명시소하동이편한세상107동1402호"), so whitespace is
 * stripped up front and every part is found by shape rather than by position.
 * An earlier version split on spaces and produced "미지정" for exactly that
 * input — the most common way an address actually arrives.
 */

export interface ParsedAddress {
  /** 시도 (경기도, 서울특별시 ...). */
  sido: string;
  /** 시군구, including a nested 구 when present (성남시분당구). */
  sigungu: string;
  /** sido + sigungu, e.g. 경기도광명시. */
  region: string;
  /** 읍/면/동/리, e.g. 소하동. */
  dong: string;
  /**
   * Apartment or building name. Falls back to `dong` when the address carries
   * no building, so two different jobs in one 시군구 on the same day still land
   * in different folders instead of merging into "0825_경기도광명시".
   */
  building: string;
}

const UNSET = '미지정';

/**
 * 시도, longest form first so 서울특별시 is not cut short at 서울.
 * Both the formal and the everyday short form are accepted.
 */
const SIDO_NAMES = [
  '서울특별시', '부산광역시', '대구광역시', '인천광역시', '광주광역시', '대전광역시',
  '울산광역시', '세종특별자치시', '경기도', '강원특별자치도', '강원도', '충청북도',
  '충청남도', '전북특별자치도', '전라북도', '전라남도', '경상북도', '경상남도',
  '제주특별자치도', '제주도',
  '서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종', '경기', '강원',
  '충북', '충남', '전북', '전남', '경북', '경남', '제주',
];

/**
 * 시 / 군 / 구. Non-greedy from one character so 서구 matches as 서+구 while
 * 구로구 still resolves to 구로+구 rather than stopping at the leading 구.
 */
const SIGUNGU = /^[가-힣]{1,6}?[시군구]/;

/** 읍 / 면 / 동 / 리, plus the 1가·2가 form used in older city centres. */
const DONG = /^[가-힣]{1,5}?[읍면동리](?=[^가-힣]|[가-힣]|$)/;
const DONG_GA = /^[가-힣]{1,4}\d*가/;

/** 도로명 + 건물번호: 하안로60, 테헤란로123, 중앙로12번길5. */
const ROAD = /^[가-힣A-Za-z0-9]{1,12}?[로길]\d*(번길)?\d*(-\d+)?/;

/**
 * Unit markers, stripped from the end one at a time.
 *
 * Only trailing matches are removed, which is what keeps a number that belongs
 * to the name: 래미안3단지101동1402호 loses 1402호 then 101동 and keeps 3단지.
 */
const UNIT_SUFFIXES = [
  /(\d+|[A-Za-z])동$/, // 107동, A동
  /\d+호$/, // 1402호
  /(지하)?\d*층$/, // 5층, 지하1층
  /^지하\d*$/, // 지하
  /[A-Za-z]?\d+가구$/,
];

function stripUnits(value: string): string {
  let out = value;
  let changed = true;

  while (changed && out) {
    changed = false;
    for (const pattern of UNIT_SUFFIXES) {
      const next = out.replace(pattern, '');
      if (next !== out) {
        out = next;
        changed = true;
      }
    }
  }
  return out;
}

export function parseAddress(address: string): ParsedAddress {
  // Spacing carries no information here and is inconsistent in practice.
  let rest = (address || '').replace(/\s+/g, '');

  if (!rest) {
    return { sido: UNSET, sigungu: UNSET, region: UNSET, dong: '', building: '' };
  }

  // 시도
  let sido = '';
  for (const name of SIDO_NAMES) {
    if (rest.startsWith(name)) {
      sido = name;
      rest = rest.slice(name.length);
      break;
    }
  }

  // 시군구 — a 시 may be followed by a 구 (성남시분당구); a 구 or 군 ends it.
  let sigungu = '';
  for (let depth = 0; depth < 2; depth += 1) {
    const match = rest.match(SIGUNGU);
    if (!match) break;

    sigungu += match[0];
    rest = rest.slice(match[0].length);
    if (!match[0].endsWith('시')) break;
  }

  // 읍면동리 — recorded, then set aside.
  let dong = '';
  const dongMatch = rest.match(DONG) || rest.match(DONG_GA);
  if (dongMatch) {
    dong = dongMatch[0];
    rest = rest.slice(dong.length);
  }

  // 도로명 주소는 건물명이 아니므로 버립니다.
  const roadMatch = rest.match(ROAD);
  if (roadMatch) rest = rest.slice(roadMatch[0].length);

  // 남은 것에서 동·호·층을 떼면 건물명입니다.
  const building = stripUnits(rest).replace(/^[-_,.]+|[-_,.]+$/g, '');

  return {
    sido: sido || UNSET,
    sigungu: sigungu || UNSET,
    region: `${sido}${sigungu}` || UNSET,
    dong,
    // Without a building name the 동 is the most specific thing left, and it
    // keeps two same-day jobs in one 시군구 from sharing a folder.
    building: building || dong,
  };
}
