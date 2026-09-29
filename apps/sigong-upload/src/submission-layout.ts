/**
 * 자료 업로드 화면의 입력 항목 순서.
 *
 * 순서를 설정으로 뺀 이유: 업체마다 기사에게 묻는 차례가 다릅니다. 어떤 곳은
 * 현장을 먼저 특정하고 누가 갔는지를 나중에 적고, 어떤 곳은 반대입니다. 코드에
 * 순서를 박아 두면 그때마다 배포를 해야 하고, 그 사이 기사들은 자기 순서가
 * 아닌 화면을 씁니다.
 *
 * 이 파일은 서버·화면이 함께 씁니다. 순서의 정의가 두 곳에 나뉘면 설정 화면이
 * 보여 주는 항목과 실제로 그려지는 항목이 어긋나기 때문입니다.
 */

export type SubmissionFieldKey =
  | 'constructionType'
  | 'siteFields'
  | 'pickDate'
  | 'workOrder'
  | 'technicians'
  | 'customerName'
  | 'address'
  | 'constructionDate'
  | 'notes';

export interface SubmissionFieldMeta {
  key: SubmissionFieldKey;
  label: string;
  hint: string;
  /** 순서를 바꿀 수 없는 항목. 뒤의 모든 것이 이 값에 매여 있습니다. */
  fixed?: boolean;
  /** 뺄 수 없는 항목. 없으면 제출 자체가 성립하지 않습니다. */
  required?: boolean;
  /** 직접 입력을 고른 뒤에만 나오는 항목. */
  manualOnly?: boolean;
  /** 주문건 수집 방식에서만 쓰는 항목. 직접 입력 방식에서는 목록에서 사라집니다. */
  orderOnly?: boolean;
  /** 관리자가 필수/선택을 정할 수 있는 항목과 그 기본값. 없으면 전환 불가. */
  requiredByDefault?: boolean;
}

/**
 * 제출 방식.
 *
 * - order: 주문서에서 들어온 주문건을 고릅니다. 목록에 없으면 직접 입력으로 넘어갑니다.
 * - manual: 주문건을 받지 않는 업체. 목록 없이 설정한 항목만 받습니다.
 */
export type SubmissionMode = 'order' | 'manual';

/** 시공종류 하나의 입력 화면 설정. */
export interface SubmissionLayout {
  mode: SubmissionMode;
  order: SubmissionFieldKey[];
  /** 필수로 받는 항목. 필수/선택을 정할 수 있는 항목만 들어갑니다. */
  required: SubmissionFieldKey[];
}

export const SUBMISSION_FIELDS: SubmissionFieldMeta[] = [
  {
    key: 'constructionType',
    label: '시공종류',
    hint: '항상 맨 앞입니다. 현장종류·주문건 목록·폴더 규칙이 모두 이 값에서 갈라집니다.',
    fixed: true,
    required: true,
  },
  {
    key: 'siteFields',
    label: '현장종류 · 업체별 입력 항목',
    hint: '시공종류마다 설정한 추가 입력 항목. 주문서 시트 이름이 곧 현장종류입니다.',
  },
  { key: 'pickDate', label: '날짜', hint: '주문건 목록을 거를 시공일.', orderOnly: true },
  {
    key: 'workOrder',
    label: '등록된 주문건 목록',
    hint: '그 날짜의 시공건을 고릅니다. 목록에 없으면 직접 입력으로 넘어갑니다. 빼면 직접 입력 방식이 됩니다.',
    orderOnly: true,
  },
  {
    key: 'technicians',
    label: '시공기사',
    hint: '실제로 다녀온 기사. 주문서의 예정 기사와 달라도 됩니다.',
    requiredByDefault: true,
  },
  {
    key: 'customerName',
    label: '주문자명',
    hint: '직접 입력일 때만 나옵니다. 주문건을 골랐으면 그 값을 씁니다.',
    manualOnly: true,
    requiredByDefault: true,
  },
  {
    key: 'address',
    label: '현장주소',
    hint: '직접 입력일 때만 나옵니다. 주문건을 골랐으면 그 주소를 씁니다.',
    manualOnly: true,
    requiredByDefault: true,
  },
  {
    key: 'constructionDate',
    label: '실제 시공일',
    hint: '직접 입력일 때만 나옵니다. 주문건을 골랐으면 그 예정일을 씁니다. 선택 입력이면 비워 둘 때 제출일을 씁니다.',
    manualOnly: true,
    requiredByDefault: true,
  },
  { key: 'notes', label: '특이사항', hint: '기사가 남기는 메모.', requiredByDefault: false },
];

const META = new Map(SUBMISSION_FIELDS.map((field) => [field.key, field]));

export function submissionFieldMeta(key: SubmissionFieldKey): SubmissionFieldMeta {
  return META.get(key) ?? { key, label: key, hint: '' };
}

/** 기본 차례: 시공종류 → 현장종류 → 날짜 → 주문건 → 시공기사 → (직접 입력 항목) → 특이사항. */
export const DEFAULT_SUBMISSION_ORDER: SubmissionFieldKey[] = [
  'constructionType',
  'siteFields',
  'pickDate',
  'workOrder',
  'technicians',
  'customerName',
  'address',
  'constructionDate',
  'notes',
];

/**
 * 저장된 순서를 믿을 수 있는 순서로 만듭니다.
 *
 * 모르는 키는 버리고, 필수 항목은 빠져 있어도 되돌려 놓습니다. 필수가 아닌
 * 항목은 **빠진 채로 둡니다** — 관리자가 일부러 뺀 것이기 때문입니다. 예전에는
 * 빠진 것을 전부 채워 넣어서, 설정에서 아무리 지워도 화면에는 그대로 나왔습니다.
 *
 * 아무것도 저장돼 있지 않으면(새 시공종류) 기본 차례를 씁니다. 빈 목록을
 * "전부 뺀 것"으로 읽으면 새 업체의 제출 화면이 시공종류 하나만 남습니다.
 * 시공종류는 무엇이 저장돼 있든 맨 앞으로 되돌립니다.
 */
function normalizeSubmissionOrder(input: unknown, mode: SubmissionMode): SubmissionFieldKey[] {
  const raw = Array.isArray(input) && input.length > 0 ? input : DEFAULT_SUBMISSION_ORDER;
  const seen = new Set<SubmissionFieldKey>();
  const order: SubmissionFieldKey[] = [];

  for (const value of raw) {
    const key = String(value) as SubmissionFieldKey;
    if (!META.has(key) || seen.has(key) || key === 'constructionType') continue;
    if (mode === 'manual' && META.get(key)?.orderOnly) continue;
    seen.add(key);
    order.push(key);
  }
  // 필수 항목이 빠져 있으면 기본 자리에 되돌립니다.
  for (const key of DEFAULT_SUBMISSION_ORDER) {
    if (key === 'constructionType' || seen.has(key) || !META.get(key)?.required) continue;
    const at = DEFAULT_SUBMISSION_ORDER.indexOf(key);
    const before = order.findIndex((other) => DEFAULT_SUBMISSION_ORDER.indexOf(other) > at);
    order.splice(before < 0 ? order.length : before, 0, key);
    seen.add(key);
  }
  return ['constructionType', ...order];
}

export function defaultRequiredFields(): SubmissionFieldKey[] {
  return SUBMISSION_FIELDS.filter((field) => field.requiredByDefault).map((field) => field.key);
}

/**
 * 저장된 설정을 믿을 수 있는 설정으로 만듭니다.
 *
 * 예전에는 순서 배열만 저장했습니다. 그 값은 주문건 수집 방식 + 기본 필수값으로
 * 읽습니다 — 이미 쓰던 업체의 화면이 저장 형식이 바뀌었다고 달라지면 안 됩니다.
 *
 * 주문건 목록을 뺀 주문건 수집 방식은 성립하지 않으므로 직접 입력 방식으로
 * 봅니다. 목록을 빼는 것과 직접 입력을 고르는 것은 같은 뜻입니다.
 */
export function normalizeSubmissionLayout(input: unknown): SubmissionLayout {
  const value = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as {
    mode?: unknown;
    order?: unknown;
    required?: unknown;
  };
  const rawOrder = Array.isArray(input) ? input : value.order;
  let mode: SubmissionMode = value.mode === 'manual' ? 'manual' : 'order';
  if (
    mode === 'order' &&
    Array.isArray(rawOrder) &&
    rawOrder.length > 0 &&
    !rawOrder.includes('workOrder')
  ) {
    mode = 'manual';
  }
  const order = normalizeSubmissionOrder(rawOrder, mode);
  const storedRequired = Array.isArray(value.required) ? (value.required as unknown[]) : null;
  const required = storedRequired
    ? SUBMISSION_FIELDS.filter(
        (field) => field.requiredByDefault !== undefined && storedRequired.includes(field.key)
      ).map((field) => field.key)
    : defaultRequiredFields();
  return { mode, order, required };
}

export const DEFAULT_SUBMISSION_LAYOUT: SubmissionLayout = normalizeSubmissionLayout(null);

/**
 * 그 항목을 반드시 받아야 하는지. 화면에서 뺀 항목은 필수일 수 없습니다 —
 * 기사가 채울 칸이 없는데 필수로 두면 제출이 영영 막힙니다.
 */
export function isSubmissionFieldRequired(layout: SubmissionLayout, key: SubmissionFieldKey): boolean {
  return layout.order.includes(key) && layout.required.includes(key);
}
