/**
 * Korean address parsing for folder names.
 *
 * A submitted address is whatever the office pasted from an order sheet or a
 * field worker typed on a phone. Folders should group by place, not by
 * household, so this pulls out:
 *
 *   region    시도 + 시군구, e.g. "경기 오산시"
 *   dong      읍/면/동/리, e.g. "벌음동"
 *   building  the apartment or building name, e.g. "호반써밋라프리미어"
 *
 * Dropping the unit number is the point: 1904동 902호 and 102동 903호 are the
 * same site visit, and separate folders per household would scatter one job
 * across dozens of directories.
 *
 * The parenthesis is the most reliable signal in a modern Korean address —
 * "초평중앙로 65 (벌음동, 호반써밋라프리미어)" states the 법정동 and the
 * building name explicitly, in that order. Reading it first, before any other
 * guessing, is what makes the rest simple.
 */

export interface ParsedAddress {
  /** 시도 (경기, 서울 ...). */
  sido: string;
  /** 시군구, including a nested 구 when present (수원시 권선구). */
  sigungu: string;
  /** sido + sigungu, e.g. "경기 오산시". */
  region: string;
  /** 읍/면/동/리, e.g. 벌음동. */
  dong: string;
  /**
   * Apartment or building name. Falls back to `dong` when the address carries
   * no building, so two different jobs in one 시군구 on the same day still land
   * in different folders instead of merging into one.
   */
  building: string;
  /** "경기 오산시 호반써밋라프리미어" — 목록과 폴더에 쓰는 짧은 형태. */
  short: string;
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

/** 읍 / 면 / 동 / 리, plus the 1가·2가 form used in older city centres. */
const DONG_SHAPE = /^[가-힣]{1,5}(\d+가)?[읍면동리]$/;

/**
 * 도로명. 이름이 로/길로 끝나고 뒤에 건물번호가 붙습니다.
 *
 * 시군구 판정에서 이 모양을 먼저 제외하는 것이 핵심입니다 — "문시로" 를
 * 토큰으로 보지 않고 글자만 훑으면 "문시" 가 시군구로 잡히고, 그러면 주소가
 * "경기오산시문시" 라는 존재하지 않는 지역이 됩니다.
 */
const ROAD_SHAPE = /[로길]\d*(번길)?$/;

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
  /^지하\d*$/,
  /[A-Za-z]?\d+가구$/,
  /\d+-\d+$/, // 117-1202 처럼 동호수를 하이픈으로 붙인 형태
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
  return out.replace(/^[-_,.\s]+|[-_,.\s]+$/g, '');
}

/** 괄호 안의 "법정동, 건물명" 을 읽습니다. 형식이 가장 분명한 부분입니다. */
function readParenthesis(address: string): { dong: string; building: string } {
  const match = /[(（]([^)）]*)[)）]/.exec(address);
  if (!match) return { dong: '', building: '' };

  const parts = match[1]!
    .split(/[,·/]/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return { dong: '', building: '' };

  // "(벌음동, 호반써밋라프리미어)" — 앞은 법정동, 뒤는 건물명.
  const first = parts[0]!;
  if (parts.length >= 2) {
    return {
      dong: DONG_SHAPE.test(first) ? first : '',
      building: parts[parts.length - 1]!,
    };
  }
  // 하나뿐이면 모양으로 판단합니다.
  return DONG_SHAPE.test(first) ? { dong: first, building: '' } : { dong: '', building: first };
}

/**
 * 시도와 시군구를 토큰 단위로 읽습니다.
 *
 * 공백이 있으면 토큰이 곧 경계입니다. 공백이 전혀 없는 주소도 실제로 들어오므로
 * ("경기도광명시소하동…"), 그때만 글자 단위 매칭으로 넘어갑니다.
 */
function readRegion(address: string): { sido: string; sigungu: string; rest: string } {
  const tokens = address.split(/\s+/).filter(Boolean);

  if (tokens.length > 1) {
    let index = 0;
    let sido = '';
    const head = tokens[0]!;
    const matched = SIDO_NAMES.find((name) => head === name || head.startsWith(name));
    if (matched) {
      sido = head;
      index = 1;
    }

    let sigungu = '';
    // 최대 두 단계 (수원시 권선구). 도로명은 시군구가 아닙니다.
    for (let depth = 0; depth < 2 && index < tokens.length; depth += 1) {
      const token = tokens[index]!;
      if (ROAD_SHAPE.test(token) || !/[시군구]$/.test(token)) break;
      sigungu = sigungu ? `${sigungu} ${token}` : token;
      index += 1;
      if (!token.endsWith('시')) break;
    }
    return { sido, sigungu, rest: tokens.slice(index).join(' ') };
  }

  // 공백 없는 주소 — 글자 단위로 훑습니다.
  let rest = tokens[0] ?? '';
  const sido = SIDO_NAMES.find((name) => rest.startsWith(name)) ?? '';
  if (sido) rest = rest.slice(sido.length);

  let sigungu = '';
  for (let depth = 0; depth < 2; depth += 1) {
    const match = /^[가-힣]{1,6}?[시군구]/.exec(rest);
    if (!match) break;
    sigungu += match[0];
    rest = rest.slice(match[0].length);
    if (!match[0].endsWith('시')) break;
  }
  return { sido, sigungu, rest };
}

export function parseAddress(address: string): ParsedAddress {
  const raw = (address || '').replace(/\s+/g, ' ').trim();
  if (!raw) {
    return { sido: UNSET, sigungu: UNSET, region: UNSET, dong: '', building: '', short: UNSET };
  }

  // 1) 괄호 먼저. 가장 확실한 정보라 다른 추측보다 앞섭니다.
  const paren = readParenthesis(raw);
  const withoutParen = raw.replace(/[(（][^)）]*[)）]/g, ' ').replace(/\s+/g, ' ').trim();

  // 2) 시도 · 시군구
  const { sido, sigungu, rest } = readRegion(withoutParen);

  // 3) 동 — 괄호에 없었다면 남은 토큰에서 찾습니다.
  let dong = paren.dong;
  let remaining = rest;
  if (!dong) {
    const tokens = remaining.split(/\s+/).filter(Boolean);
    const hit = tokens.findIndex((token) => DONG_SHAPE.test(token));
    if (hit >= 0) {
      dong = tokens[hit]!;
      remaining = tokens.filter((_, index) => index !== hit).join(' ');
    } else if (tokens.length === 1) {
      // 공백 없이 붙여 쓴 주소 — "소하동이편한세상" 처럼 동과 건물명이 한 덩어리로
      // 옵니다. 앞쪽의 읍면동리 모양만 떼어내면 나머지가 건물명입니다.
      const leading = /^[가-힣]{1,5}(\d+가)?[읍면동리]/.exec(tokens[0]!);
      if (leading && leading[0].length < tokens[0]!.length) {
        dong = leading[0];
        remaining = tokens[0]!.slice(leading[0].length);
      }
    }
  }

  // 4) 건물명 — 괄호에 있으면 그것이 정답입니다. 없으면 도로명과 동호수를
  //    걷어낸 나머지에서 찾습니다.
  let building = paren.building;
  if (!building) {
    const leftovers = remaining
      .split(/\s+/)
      .filter(Boolean)
      // 도로명과 건물번호는 이름이 아닙니다.
      .filter((token) => !ROAD_SHAPE.test(token) && !/^\d+(-\d+)?$/.test(token));
    building = stripUnits(leftovers.join(''));
  }
  building = stripUnits(building);

  const region = [sido, sigungu].filter(Boolean).join(' ');
  const name = building || dong;

  return {
    sido: sido || UNSET,
    sigungu: sigungu || UNSET,
    region: region || UNSET,
    dong,
    // Without a building name the 동 is the most specific thing left, and it
    // keeps two same-day jobs in one 시군구 from sharing a folder.
    building: name,
    short: [region, name].filter(Boolean).join(' ') || UNSET,
  };
}
