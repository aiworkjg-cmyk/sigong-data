import { config } from './config';
import type { SheetTable } from './spreadsheet';

/**
 * 이미지 주문서에서 표를 읽어냅니다.
 *
 * Azure AI Document Intelligence의 prebuilt-layout 모델을 씁니다. 일반 OCR이
 * 아니라 레이아웃 모델을 쓰는 이유: 주문서는 표이고, 줄 단위 텍스트만 받으면
 * 어느 값이 어느 열인지 다시 추측해야 합니다. 레이아웃 모델은 셀의 행·열
 * 좌표를 그대로 돌려주므로, 엑셀을 읽었을 때와 똑같은 사각형이 나옵니다.
 *
 * 설정이 없으면 조용히 실패하지 않고 무엇을 설정해야 하는지 말합니다 —
 * "이미지에서 아무것도 못 읽었다"는 메시지는 원인을 알려주지 않습니다.
 */

export class OcrError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = 'OcrError';
  }
}

/** 분석은 비동기입니다. 이 시간을 넘으면 포기합니다. */
const POLL_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 1500;

export function isOcrConfigured(): boolean {
  return Boolean(config.ocr.endpoint && config.ocr.key);
}

interface LayoutCell {
  rowIndex: number;
  columnIndex: number;
  content?: string;
}

interface LayoutResult {
  content?: string;
  tables?: Array<{
    rowCount: number;
    columnCount: number;
    cells: LayoutCell[];
  }>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 이미지(또는 PDF) 바이트를 표로 변환합니다.
 *
 * 표를 찾지 못하면 줄 단위 텍스트라도 돌려줍니다. 사람이 화면에서 열을 맞출 수
 * 있으므로, 완벽하지 않은 결과도 아무것도 없는 것보다는 쓸모가 있습니다.
 */
export async function readOrderImage(
  content: Buffer,
  contentType: string
): Promise<{ table: SheetTable; text: string }> {
  if (!isOcrConfigured()) {
    throw new OcrError(
      '이미지 주문서를 읽으려면 OCR 설정이 필요합니다. ' +
        '서버에 AZURE_OCR_ENDPOINT 와 AZURE_OCR_KEY 를 등록해 주세요. ' +
        '(Azure 포털 > AI Document Intelligence 리소스 > 키 및 엔드포인트)',
      501
    );
  }

  const base = config.ocr.endpoint.replace(/\/$/, '');
  const url =
    `${base}/documentintelligence/documentModels/prebuilt-layout:analyze` +
    `?api-version=${encodeURIComponent(config.ocr.apiVersion)}&outputContentFormat=text`;

  const started = await fetch(url, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': config.ocr.key,
      'Content-Type': contentType || 'application/octet-stream',
    },
    body: new Uint8Array(content),
  });

  if (!started.ok) {
    const detail = await started.text().catch(() => '');
    throw new OcrError(
      started.status === 401 || started.status === 403
        ? 'OCR 키가 올바르지 않거나 권한이 없습니다. AZURE_OCR_KEY 를 확인해 주세요.'
        : `이미지 분석 요청이 거부되었습니다 (HTTP ${started.status}). ${detail.slice(0, 300)}`,
      502
    );
  }

  // The analyze call is asynchronous: it answers 202 with a polling URL.
  const operation = started.headers.get('operation-location');
  if (!operation) throw new OcrError('OCR 분석 상태 주소를 받지 못했습니다.', 502);

  const analyzed = await pollAnalysis(operation);
  return { table: layoutToTable(analyzed), text: analyzed.content || '' };
}

async function pollAnalysis(operationUrl: string): Promise<LayoutResult> {
  const parsed = new URL(operationUrl);
  // The polling URL comes from a response body; confining it to the configured
  // endpoint's host stops a redirected or spoofed value sending the key on.
  if (parsed.origin !== new URL(config.ocr.endpoint).origin) {
    throw new OcrError('OCR 서비스가 예상하지 않은 주소를 반환했습니다.', 502);
  }

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const res = await fetch(operationUrl, {
      headers: { 'Ocp-Apim-Subscription-Key': config.ocr.key },
    });
    if (!res.ok) throw new OcrError(`OCR 결과 조회 실패 (HTTP ${res.status})`, 502);

    const body = (await res.json()) as {
      status?: string;
      error?: { message?: string };
      analyzeResult?: LayoutResult;
    };
    if (body.status === 'succeeded') return body.analyzeResult ?? {};
    if (body.status === 'failed') {
      throw new OcrError(body.error?.message || '이미지 분석에 실패했습니다.', 502);
    }
  }
  throw new OcrError('이미지 분석이 시간 안에 끝나지 않았습니다. 더 작거나 선명한 이미지로 다시 시도해 주세요.', 504);
}

/**
 * 레이아웃 결과에서 가장 큰 표를 골라 사각형으로 폅니다.
 *
 * 주문서 이미지에는 머리글·도장·안내문 같은 작은 표가 함께 잡히는 일이 흔합니다.
 * 셀 수가 가장 많은 표가 실제 주문 목록입니다.
 */
function layoutToTable(result: LayoutResult): SheetTable {
  const warnings: string[] = [];
  const tables = result.tables || [];

  if (tables.length === 0) {
    // No table detected — fall back to lines so the person can still map them.
    const lines = (result.content || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return {
      headers: lines.length ? ['읽은 내용'] : [],
      rows: lines.map((line) => [line]),
      warnings: [
        '이미지에서 표를 찾지 못했습니다. 읽은 줄을 그대로 보여 드리니, 열 연결을 직접 지정하거나 엑셀로 다시 올려 주세요.',
      ],
    };
  }

  const biggest = tables.reduce((best, table) =>
    table.cells.length > best.cells.length ? table : best
  );
  if (tables.length > 1) {
    warnings.push(`표가 ${tables.length}개 인식되었습니다. 가장 큰 표만 읽었습니다.`);
  }
  warnings.push('이미지에서 읽은 값입니다. 등록 전에 각 줄을 반드시 확인해 주세요.');

  const grid: string[][] = Array.from({ length: biggest.rowCount }, () =>
    Array.from({ length: biggest.columnCount }, () => '')
  );
  for (const cell of biggest.cells) {
    const row = grid[cell.rowIndex];
    if (row && cell.columnIndex < row.length) {
      row[cell.columnIndex] = (cell.content || '').replace(/\s+/g, ' ').trim();
    }
  }

  const rows = grid.filter((row) => row.some((value) => value !== ''));
  const headerRow = rows[0] ?? [];
  return {
    headers: headerRow.map((value, index) => value || `열 ${index + 1}`),
    rows: rows.slice(1),
    warnings,
  };
}
