/**
 * 시도를 사람이 일정을 짤 때 쓰는 크기의 권역으로 묶습니다.
 *
 * 폴더 이름에 쓰는 `region`("경기도광명시")은 검색에는 좋지만 목록을 거르는
 * 데는 너무 잘게 나뉩니다 — 시군구는 전국에 250개가 넘고, 그중 하나를 고르는
 * 드롭다운은 아무도 못 씁니다. 배차와 일정은 "수도권 / 충청" 단위로 정해지므로
 * 필터도 그 단위여야 합니다.
 *
 * 서울은 수도권에 포함합니다. 한때 따로 두었지만, 배차가 서울과 경기·인천을
 * 나눠서 이뤄지지 않기 때문에 실제로는 두 칸을 늘 함께 눌러야 했습니다.
 * 필터가 한 번에 끝나지 않으면 그 자체로 놓치는 건이 생깁니다.
 */

export const REGION_GROUPS = [
  '수도권',
  '강원',
  '충북',
  '충남',
  '전북',
  '전남',
  '경북',
  '경남',
  '제주',
  '기타',
] as const;

export type RegionGroup = (typeof REGION_GROUPS)[number];

/**
 * 시도 표기의 흔들림을 흡수하는 표.
 *
 * 주문서마다 "경기", "경기도", "충남", "충청남도" 가 섞여 들어오고, 광역시는
 * "부산", "부산시", "부산광역시" 가 모두 나타납니다. 앞부분만 보고 판단하므로
 * 뒤에 무엇이 붙든 상관없습니다.
 */
const PREFIXES: Array<[RegionGroup, string[]]> = [
  ['수도권', ['서울', '경기', '인천']],
  ['강원', ['강원']],
  ['충북', ['충북', '충청북', '청주', '충주', '제천']],
  ['충남', ['충남', '충청남', '대전', '세종', '천안', '아산']],
  ['전북', ['전북', '전라북', '전주', '익산', '군산']],
  ['전남', ['전남', '전라남', '광주', '여수', '순천', '목포']],
  ['경북', ['경북', '경상북', '대구', '포항', '구미', '경주']],
  ['경남', ['경남', '경상남', '부산', '울산', '창원', '김해', '진주']],
  ['제주', ['제주']],
];

/**
 * 주소나 시도 문자열에서 권역을 고릅니다.
 *
 * 알아보지 못하면 '기타'입니다. 억지로 어딘가에 넣는 것보다, 필터에서 '기타'로
 * 모여 눈에 띄는 편이 낫습니다 — 그래야 주소가 이상하다는 사실이 드러납니다.
 */
/**
 * 저장돼 있던 권역 값을 지금 쓰는 권역으로 맞춥니다.
 *
 * 서울을 수도권에 합치기 전에 저장된 건들은 regionGroup 이 '서울'인 채로
 * 남아 있습니다. 다음 동기화에서 다시 계산되지만, 그 전까지 필터에서
 * 사라져 보이면 안 되므로 읽을 때 흡수합니다.
 */
export function normalizeRegionGroup(value?: string): RegionGroup {
  const text = (value || '').trim();
  if (text === '서울') return '수도권';
  return (REGION_GROUPS as readonly string[]).includes(text) ? (text as RegionGroup) : '기타';
}

export function regionGroupOf(address: string): RegionGroup {
  const text = (address || '').replace(/\s+/g, '');
  if (!text) return '기타';

  for (const [group, prefixes] of PREFIXES) {
    if (prefixes.some((prefix) => text.startsWith(prefix))) return group;
  }
  // 앞이 아니라 중간에 나오는 경우도 받아 줍니다 ("대한민국 경기도 …").
  for (const [group, prefixes] of PREFIXES) {
    if (prefixes.some((prefix) => text.includes(prefix))) return group;
  }
  return '기타';
}
