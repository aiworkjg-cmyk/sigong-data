import crypto from 'crypto';
import { parseAddress } from '@jg/sharepoint-core';
import { regionGroupOf } from '../src/region';
import type { SheetTable } from './spreadsheet';
import type {
  WorkOrderColumnMap,
  WorkOrderDraft,
  WorkOrderSource,
} from '../src/types';

/**
 * Turns a rectangle of spreadsheet text into reviewable 주문 rows.
 *
 * Nothing here writes to the store. Every import — Excel, OCR, Google Sheet —
 * lands in the same preview shape and is confirmed on screen before it becomes
 * a work order. That review step is not politeness: a column guessed wrong, or
 * a date read as 08/09 when it meant September 8th, produces work orders that
 * technicians cannot find and nobody notices until a site is missed.
 */

export const EMPTY_MAPPING: WorkOrderColumnMap = {
  constructionType: '', orderNumber: '', customerName: '', phone: '',
  address: '', scheduledDate: '', notes: '', status: '',
};

/**
 * 이 말이 상태 칸에 있으면 주문건으로 받아오지 않습니다.
 *
 * 취소만이 아니라 **시공완료**도 뺍니다. 이 목록은 "기사가 지금 가서 자료를
 * 올려야 하는 현장"이고, 이미 끝난 건은 거기에 들어갈 자리가 없습니다.
 * 끝난 건까지 남겨 두면 목록이 계속 길어지기만 하고 기사는 매번 지나간 건을
 * 넘겨야 합니다.
 *
 * "시공x" 는 시공 없이 제품만 보내는 건입니다 — 올릴 자료가 아예 없습니다.
 * 띄어쓰기와 대소문자가 제각각이라(시공x / 시공 X / 시공×) 공백을 지우고
 * 소문자로 맞춘 뒤 비교합니다.
 */
const CANCELLED_WORDS = [
  '취소', '반품', '철회', '펑크',
  '시공완료',
  '시공x', '시공×', '시공엑스',
];

/**
 * 어떤 말 때문에 제외되었는지.
 *
 * 개수만 알려 주면 "151건 제외" 가 맞는 숫자인지 판단할 수 없습니다. 사유별로
 * 나눠 보여 주면 "시공완료 120 · 취소 31" 처럼 읽히고, 규칙이 엉뚱한 열에
 * 걸렸을 때 그 사실이 숫자 모양에서 바로 드러납니다.
 */
export function cancelReason(value: string): string {
  const text = (value || '').replace(/\s+/g, '').toLowerCase();
  if (!text) return '';
  for (const word of CANCELLED_WORDS) {
    if (text.includes(word)) return word;
  }
  return '';
}

/** 상태 칸의 값이 "이 주문은 없던 일이 되었다"는 뜻인지. */
export function looksCancelled(value: string): boolean {
  // 공백 제거 + 소문자: "시공 X" 와 "시공x" 가 같은 뜻이기 때문입니다.
  const text = (value || '').replace(/\s+/g, '').toLowerCase();
  if (!text) return false;
  // "취소 요청 있었으나 진행" 같은 문장은 취소가 아닙니다. 뒤집는 말이 함께
  // 있으면 사람이 판단하도록 남겨 둡니다.
  if (/(취소.{0,6}(안함|안됨|철회|보류|진행|아님))|((진행|유지).{0,4}취소아)/.test(text)) return false;
  return CANCELLED_WORDS.some((word) => text.includes(word));
}

/**
 * Header names seen on real order sheets, per field.
 *
 * Matching is on a normalised form (lowercased, spaces and punctuation
 * removed), so "시공 예정일", "시공예정일", and "시공예정일자" all land together.
 */
const HEADER_ALIASES: Record<keyof WorkOrderColumnMap, string[]> = {
  // 좁게 잡습니다. "제품"·"품목"·"구분" 까지 받으면 "주문내역(제품명/수량/전시가)"
  // 같은 열이 시공종류로 잡히고, 그러면 모든 줄이 "등록되지 않은 시공종류"가 됩니다.
  // 시공종류는 어차피 불러올 때 화면에서 고르므로, 억지로 알아맞힐 이유가 없습니다.
  constructionType: ['시공종류', '시공유형', 'constructiontype'],
  orderNumber: ['주문번호', '주문no', '오더번호', '접수번호', '수주번호', '관리번호', 'orderno', 'ordernumber', 'no'],
  customerName: ['주문자', '주문자명', '고객명', '고객', '성명', '이름', '수취인', '건축주', 'customer', 'name'],
  phone: ['연락처', '전화', '전화번호', '휴대폰', '핸드폰', '휴대전화', 'tel', 'phone', 'mobile'],
  address: ['주소', '시공주소', '현장주소', '배송주소', '배송지', '설치주소', '소재지', 'address'],
  scheduledDate: [
    '시공일', '시공예정일', '시공일자', '예정일', '설치일', '방문일', '작업일',
    '시공예정일/시공완료', '시공예정일시공완료', 'date', 'scheduleddate',
  ],
  notes: ['비고', '메모', '특이사항', '요청사항', '참고', 'note', 'notes', 'remark'],
  status: ['주문상태', '상태', '진행상태', '시공상태', '처리상태', '진행', 'status'],
};

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[\s_\-().]/g, '');
}

/**
 * Guesses which column is which.
 *
 * Exact alias matches are taken first across every field, and only then are
 * partial matches considered — otherwise a column called "주문번호" could be
 * claimed by `customerName` on the substring "주문" before `orderNumber` ever
 * got to look at it.
 */
export function detectMapping(headers: string[], rows: string[][] = []): WorkOrderColumnMap {
  const mapping: WorkOrderColumnMap = { ...EMPTY_MAPPING };
  const taken = new Set<string>();
  const fields = Object.keys(HEADER_ALIASES) as Array<keyof WorkOrderColumnMap>;

  const claim = (field: keyof WorkOrderColumnMap, header: string) => {
    mapping[field] = header;
    taken.add(header);
  };

  for (const field of fields) {
    const aliases = HEADER_ALIASES[field].map(normalizeHeader);
    const hit = headers.find(
      (header) => !taken.has(header) && aliases.includes(normalizeHeader(header))
    );
    if (hit) claim(field, hit);
  }
  for (const field of fields) {
    if (mapping[field]) continue;
    const aliases = HEADER_ALIASES[field].map(normalizeHeader);
    const hit = headers.find((header) => {
      if (taken.has(header)) return false;
      const name = normalizeHeader(header);
      return aliases.some((alias) => alias.length >= 2 && name.includes(alias));
    });
    if (hit) claim(field, hit);
  }

  // 상태 전용 열이 없으면, 취소가 실제로 가장 많이 적힌 열을 제안합니다.
  // 실제 주문서는 상태를 비고 문장 안에 적으므로 머리글로는 찾을 수 없습니다.
  // 제안일 뿐이고, 화면에 "취소로 제외: n줄" 이 함께 나오므로 사람이 확인합니다.
  if (!mapping.status && rows.length > 0) {
    let best = { header: '', hits: 0 };
    headers.forEach((header, index) => {
      const hits = rows.filter((row) => looksCancelled(row[index] || '')).length;
      if (hits > best.hits) best = { header, hits };
    });
    // 큰 표에서 두어 줄 걸리는 것은 우연입니다 — 문장 어딘가에 "취소"가 스친
    // 정도로는 상태 열이라고 볼 수 없습니다. 그래서 비율로 봅니다. 작은 표에서는
    // 한 줄만 걸려도 그 열이 상태 열일 가능성이 높으므로 바닥을 1로 둡니다.
    if (best.hits >= Math.max(1, Math.ceil(rows.length * 0.02))) mapping.status = best.header;
  }
  return mapping;
}

/**
 * 한 칸에 같이 적힌 시공예정일과 담당 기사를 나눕니다.
 *
 * 실제 주문서의 "시공예정일 / 시공완료" 칸은 `26.05.25 / 유동현 팀장` 처럼
 * 쓰여 있습니다. 사람에게는 한 덩어리가 자연스럽지만 — 날짜를 정하는 일과
 * 기사를 정하는 일이 같은 통화에서 끝나니까요 — 목록을 날짜로 묶고 기사로
 * 거르려면 둘을 분리해야 합니다.
 *
 * 슬래시가 없으면 전체를 날짜로 보고, 날짜로 읽히지 않으면 기사 이름으로 봅니다.
 */
export function splitSchedule(value: string): { date: string; technician: string } {
  const { date, rest } = extractDate(value);
  if (!date) return { date: '', technician: '' };

  // 날짜를 뺀 나머지가 담당 기사입니다. "(예정)" 같은 메모와 구분자만 털어
  // 냅니다 — 남은 것을 통째로 이름으로 보면 "예정" 이 기사 이름이 됩니다.
  const technician = rest
    // \b 는 한글 옆에서 동작하지 않으므로(\w 가 ASCII 전용) 경계 없이 지웁니다.
    .replace(/(예정|확정|미정|변경|오전|오후)/g, ' ')
    .replace(/\d+\s*시(\s*\d+\s*분)?/g, ' ')
    .replace(/[()[\]<>/·|,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // 남은 말이 길면 이름이 아니라 메모입니다 — "고객님이 별도로 다른업체에
  // 설치하셨습니다" 를 담당 기사로 넣으면 기사 목록이 그 문장으로 오염됩니다.
  return { date, technician: technician.length <= 12 ? technician : '' };
}

/**
 * Reads a date written any of the ways a person might type one.
 *
 * Two-digit years are read as 20xx; a year beyond that is somebody's typo, and
 * guessing a century for it would only hide the mistake. Returns '' when the
 * value is not a date at all, which the caller reports as a row problem rather
 * than silently dropping.
 */
export function normalizeDate(value: string): string {
  return extractDate(value).date;
}

/**
 * 문장 안에 섞여 있는 날짜를 찾아냅니다.
 *
 * 주문서의 날짜 칸은 순수한 날짜인 경우가 오히려 드뭅니다 — "(예정) 8월29일
 * 1시", "6월 7일 고객님이 별도로 설치하셨습니다" 처럼 메모가 붙어 옵니다.
 * 예전에는 문자열 맨 앞부터만 읽어서 이런 줄이 전부 "날짜를 알아볼 수 없음"
 * 으로 빠졌습니다. 날짜가 분명히 적혀 있는데 미완성으로 처리하는 것은
 * 사람이 보기에 명백한 오작동이므로, 앞뒤에 무엇이 붙어 있든 날짜 모양을
 * 찾습니다.
 *
 * 두 자리 연도는 20xx 로 읽습니다. 그 범위를 벗어난 값은 누군가의 오타이고,
 * 세기를 추측해 주는 것은 실수를 덮을 뿐입니다.
 */
export function extractDate(value: string): { date: string; rest: string } {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  if (!text) return { date: '', rest: '' };

  const patterns: Array<[RegExp, (match: RegExpExecArray) => string]> = [
    // 2026-08-25 / 2026.8.25 / 2026년 8월 25일
    [/(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*일?/,
      (m) => stamp(Number(m[1]), Number(m[2]), Number(m[3]))],
    // 20260825
    [/(?:^|[^\d])(\d{4})(\d{2})(\d{2})(?![\d])/,
      (m) => stamp(Number(m[1]), Number(m[2]), Number(m[3]))],
    // 26.08.25
    [/(?:^|[^\d])(\d{2})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})(?![\d])/,
      (m) => stamp(2000 + Number(m[1]), Number(m[2]), Number(m[3]))],
    // 8/27, 8월 27일 — 연도가 없으면 주문서가 도는 해입니다.
    [/(?:^|[^\d])(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*일?(?![\d])/,
      (m) => stamp(new Date().getFullYear(), Number(m[1]), Number(m[2]))],
  ];

  for (const [pattern, read] of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const date = read(match);
    if (!date) continue;
    const rest = (text.slice(0, match.index) + ' ' + text.slice(match.index + match[0].length))
      .replace(/\s+/g, ' ')
      .trim();
    return { date, rest };
  }

  return { date: '', rest: text };
}

function stamp(year: number, month: number, day: number): string {
  if (!(year >= 2000 && year <= 2100) || !(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) {
    return '';
  }
  // Round-tripped through Date so 2026-02-31 is rejected rather than stored.
  const date = new Date(Date.UTC(year, month - 1, day));
  const built = date.toISOString().slice(0, 10);
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? built : '';
}

/** Keeps digits and the separators a Korean phone number is written with. */
function normalizePhone(value: string): string {
  const digits = (value || '').replace(/[^\d]/g, '');
  if (digits.length < 9 || digits.length > 11) return (value || '').trim().slice(0, 20);
  if (digits.length === 11) return digits.replace(/(\d{3})(\d{4})(\d{4})/, '$1-$2-$3');
  if (digits.length === 10 && digits.startsWith('02')) {
    return digits.replace(/(\d{2})(\d{4})(\d{4})/, '$1-$2-$3');
  }
  return digits.replace(/(\d{3})(\d{3,4})(\d{4})/, '$1-$2-$3');
}

/**
 * The identity of one order within its source.
 *
 * An order number is used when the sheet carries one, because that is the thing
 * the office actually re-sends corrections against. Failing that, the identity
 * is the combination that makes a site unique in practice — the same address on
 * the same day for the same product line is one job, not two.
 */
/** 주문번호 칸에 들어온 값이 사실은 날짜인지. */
export function looksLikeDate(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  // 날짜만 있고 다른 글자가 없을 때만입니다 — "20260519-01" 같은 진짜 번호를
  // 날짜로 몰아 버리면 반대 방향의 오작동이 됩니다.
  return /^\d{2,4}[-./]\d{1,2}[-./]\d{1,2}$/.test(text) || /^\d{8}$/.test(text);
}

export function sourceKeyFor(input: {
  source: WorkOrderSource;
  orderNumber: string;
  constructionType: string;
  address: string;
  scheduledDate: string;
  customerName: string;
}): string {
  const trimmed = input.orderNumber.trim();
  // 주문번호를 신뢰할 수 있을 때만 그것으로 같은 건인지 판단합니다.
  //
  // 실제 주문서의 "주문번호" 칸에는 날짜가 적혀 있는 경우가 있습니다
  // ("2026-05-19"). 그러면 같은 날 접수된 20건이 전부 같은 주문번호가 되고,
  // 첫 건만 남고 나머지 19건이 "중복"으로 건너뛰어집니다. 번호로 읽히지 않는
  // 값은 번호가 아니라고 보고 주소·날짜·주문자 조합으로 판단합니다.
  if (trimmed && !looksLikeDate(trimmed)) return `no:${trimmed.toLowerCase()}`;

  const parts = [input.constructionType, input.address.replace(/\s+/g, ''), input.scheduledDate, input.customerName]
    .map((part) => (part || '').trim().toLowerCase())
    .join('|');
  return `sig:${crypto.createHash('sha1').update(parts).digest('hex').slice(0, 16)}`;
}

export interface BuildDraftsOptions {
  table: SheetTable;
  mapping: WorkOrderColumnMap;
  /** Applied to every row when the sheet has no 시공종류 column of its own. */
  defaultConstructionType: string;
  /** The configured list. A value outside it becomes a row problem. */
  knownTypes: string[];
  /**
   * 현장종류 — 시트 이름에서 옵니다.
   *
   * 주문서는 거래처별로 시트를 나눠 쓰고 ("롯데백화점(흥주부)"), 그 이름이 곧
   * 현장종류입니다. 열에서 찾을 값이 아니라 시트에서 오는 값이므로 여기로 받습니다.
   */
  siteType?: string;
}

/** Applies a mapping to the table and reports what a person still has to fix. */
export function buildDrafts(options: BuildDraftsOptions): WorkOrderDraft[] {
  const { table, mapping, defaultConstructionType, knownTypes } = options;
  const indexOf = (header: string) => (header ? table.headers.indexOf(header) : -1);
  const columns = Object.fromEntries(
    (Object.keys(mapping) as Array<keyof WorkOrderColumnMap>).map((field) => [field, indexOf(mapping[field])])
  ) as Record<keyof WorkOrderColumnMap, number>;

  const mappedIndexes = new Set(Object.values(columns).filter((index) => index >= 0));

  return table.rows.map((row, position) => {
    const at = (field: keyof WorkOrderColumnMap) =>
      columns[field] >= 0 ? (row[columns[field]] || '').trim() : '';

    const constructionType = at('constructionType') || defaultConstructionType;
    const address = at('address');
    const rawDate = at('scheduledDate');
    const { date: scheduledDate, technician } = splitSchedule(rawDate);

    // 등록을 막는 것은 두 가지뿐입니다: 시공종류와 시공예정일.
    // 주소가 비어 있어도 등록은 됩니다 — 기사가 현장에서 파일을 올리는 일이
    // 주소 한 칸 때문에 막히면 안 되고, 주소는 나중에 채울 수 있습니다.
    const problems: string[] = [];
    if (!constructionType) problems.push('시공종류가 없습니다.');
    else if (knownTypes.length && !knownTypes.includes(constructionType)) {
      problems.push(`등록되지 않은 시공종류입니다: ${constructionType}`);
    }
    // 날짜를 못 읽은 것은 알려 주되, 등록 자체를 막지는 않습니다. 날짜가 비면
    // 목록에서 "날짜 미정" 으로 묶일 뿐이고, 그 한 칸 때문에 현장에서 파일을
    // 못 올리는 편이 훨씬 나쁩니다.
    if (!scheduledDate && rawDate) {
      problems.push(`날짜를 알아볼 수 없습니다: ${rawDate}`);
    }

    const statusText = at('status');
    return {
      rowKey: `row-${position + 2}`,
      // 시트에서 몇 번째 줄이었는지. 목록의 기본 정렬이 시트 순서와 같아야
      // 한 건씩 대조하며 검증할 수 있습니다.
      rowIndex: position + 2,
      cancelled: looksCancelled(statusText),
      statusText,
      constructionType,
      siteType: options.siteType || '',
      technicianName: technician,
      // 날짜가 적힌 주문번호 칸은 번호로 쓰지 않습니다 — sourceKeyFor 참고.
      orderNumber: looksLikeDate(at('orderNumber')) ? '' : at('orderNumber'),
      customerName: at('customerName'),
      phone: normalizePhone(at('phone')),
      address,
      scheduledDate,
      notes: at('notes'),
      // Unmapped columns are carried rather than discarded — see WorkOrder.extras.
      extras: table.headers
        .map((header, index) => ({ label: header, value: (row[index] || '').trim() }))
        .filter((entry, index) => !mappedIndexes.has(index) && entry.value !== ''),
      problems,
    };
  })
    /*
     * 알맹이가 없는 줄은 주문이 아닙니다.
     *
     * 시트 아래쪽에는 서식만 남은 빈 줄이 흔히 붙어 있습니다. 어느 칸엔가
     * 공백이나 잔여 서식이 있어서 "빈 줄"로 걸러지지 않고 표에는 남는데,
     * 그대로 등록하면 시공건 목록에 주소도 주문자도 없는 줄이 생기고
     * 총 항목 수가 실제보다 늘어납니다(동탄점 17건이 18건으로 보이던 원인).
     * 주문자·주소·날짜·주문번호가 모두 비었으면 주문으로 보지 않습니다.
     */
    .filter(
      (draft) =>
        Boolean(draft.customerName || draft.address || draft.scheduledDate || draft.orderNumber)
    );
}

/** Derived address parts, shared by the import path and manual entry. */
export function addressParts(
  address: string
): { region: string; regionGroup: string; building: string } {
  const parsed = parseAddress(address || '');
  return {
    region: parsed.region || '',
    regionGroup: regionGroupOf(address || ''),
    building: parsed.building || '',
  };
}
