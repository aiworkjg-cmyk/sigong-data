/**
 * 기사 화면에 개인정보를 덜 드러내기 위한 표시 규칙.
 *
 * 기사는 "어느 현장인지 알아볼 수 있을 만큼"만 보면 됩니다. 그 이상은 필요도
 * 없고, 현장에서 켜 두는 화면이라 옆에서 들여다보일 수 있습니다. 원본 값은
 * 서버에 그대로 있고 관리자 화면에서는 온전히 보이므로, 여기서 가리는 것은
 * 기사에게 보여 줄 때뿐입니다.
 */

/** "홍길동" → "홍길*", "김철" → "김*", "이" → "이". */
export function maskName(value?: string): string {
  const name = (value || '').trim();
  if (name.length <= 1) return name;
  return `${name.slice(0, -1)}*`;
}

/**
 * 주소에서 동·호수를 뺍니다.
 *
 * 남기는 것은 건물까지입니다 — "101동 1502호"가 없어도 기사는 자기가 갈
 * 현장인지 알 수 있고, 실제 동호수는 배정 문자나 주문서로 따로 받습니다.
 * 괄호 안의 법정동·건물명 설명도 함께 걷어 냅니다.
 */
export function maskAddress(value?: string): string {
  return (value || '')
    .replace(/\([^)]*\)/g, ' ')
    // 101동 1502호 / 1904동902호 / 602-101 / 4301동30
    .replace(/\d+\s*동\s*\d*\s*호?/g, ' ')
    .replace(/\d+\s*호\b/g, ' ')
    .replace(/\b\d{3,4}-\d{2,4}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[,·]\s*$/, '')
    .trim();
}
