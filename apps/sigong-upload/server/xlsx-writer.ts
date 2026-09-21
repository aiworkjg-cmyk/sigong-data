import zlib from 'zlib';

/**
 * 최소 .xlsx 생성기.
 *
 * 읽기(spreadsheet.ts)와 같은 이유로 직접 만듭니다 — .xlsx 는 XML 몇 장을 담은
 * ZIP 이고, Node 의 zlib 이 어려운 부분을 다 해 줍니다. 표 하나를 내보내려고
 * 메가바이트짜리 의존성을 들일 이유가 없습니다.
 *
 * 목표는 "그대로 열어서 볼 수 있는 파일"입니다. 머리글 굵게·색, 첫 행 고정,
 * 자동 필터, 열 너비까지 넣습니다. 이것들이 없으면 받는 사람이 매번 같은
 * 손질을 반복하게 되고, 그러면 내보내기의 의미가 절반으로 줄어듭니다.
 */

export interface SheetColumn<T> {
  header: string;
  /** 셀 값. 빈 값은 빈 칸으로 둡니다. */
  value: (row: T) => string | number | null | undefined;
  /** 열 너비(문자 수). 생략하면 머리글 길이에서 추정합니다. */
  width?: number;
}

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
};

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => XML_ESCAPES[char]!)
    // 엑셀은 XML 1.0 제어문자를 거부합니다. 주문서 비고에 실제로 섞여 옵니다.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/** 0 → A, 25 → Z, 26 → AA */
function columnName(index: number): string {
  let name = '';
  let value = index;
  do {
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return name;
}

/* ------------------------------------------------------------------ */
/* ZIP                                                                 */
/* ------------------------------------------------------------------ */

function crc32(buffer: Buffer): number {
  let crc = -1;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}

function zip(files: Array<{ name: string; content: string }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf-8');
    const raw = Buffer.from(file.content, 'utf-8');
    const body = zlib.deflateRawSync(raw);
    const sum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([Buffer.concat(locals), directory, end]);
}

/* ------------------------------------------------------------------ */
/* Sheet                                                               */
/* ------------------------------------------------------------------ */

/**
 * 값을 셀 XML 로 씁니다.
 *
 * 문자열은 inlineStr 로 넣습니다 — sharedStrings 를 쓰면 파일이 작아지지만
 * 인덱스 테이블을 따로 관리해야 하고, 수백 줄짜리 내보내기에서 그 복잡도는
 * 값을 하지 않습니다.
 */
function cell(reference: string, value: string | number | null | undefined, styleIndex: number): string {
  if (value === null || value === undefined || value === '') {
    return `<c r="${reference}" s="${styleIndex}"/>`;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${reference}" s="${styleIndex}"><v>${value}</v></c>`;
  }
  return `<c r="${reference}" s="${styleIndex}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(value))}</t></is></c>`;
}

export interface WorkbookOptions<T> {
  sheetName: string;
  columns: Array<SheetColumn<T>>;
  rows: T[];
  /** 표 위에 한 줄로 들어가는 설명. 어떤 조건으로 뽑았는지 남기는 용도입니다. */
  caption?: string;
  /**
   * 값을 고르게 할 열. 엑셀에서 목록 상자로 나옵니다.
   *
   * 직함처럼 정해진 값을 손으로 치게 두면 "팀장", "팀 장", "팀장님" 이 섞여
   * 들어오고, 그 셋이 서로 다른 직함이 됩니다. 고르게 하면 그 일이 없습니다.
   */
  choices?: Array<{ header: string; options: string[] }>;
  /** 빈 양식이어도 목록 상자를 걸어 둘 줄 수. 기본 200줄. */
  choiceRows?: number;
}

/**
 * 한 장짜리 통합문서를 만듭니다.
 *
 * caption 을 지원하는 이유: 필터를 걸어 내보낸 파일은 며칠 뒤면 "이게 무슨
 * 조건이었지"가 됩니다. 조건을 파일 안에 적어 두면 파일 하나만 봐도 알 수
 * 있습니다.
 */
export function buildWorkbook<T>(options: WorkbookOptions<T>): Buffer {
  const { columns, rows, caption } = options;
  // 시트 이름에 쓸 수 없는 문자와 31자 제한.
  const sheetName = (options.sheetName || 'Sheet1').replace(/[\\/?*[\]:]/g, '_').slice(0, 31);

  const headerRow = caption ? 2 : 1;
  const body: string[] = [];

  if (caption) {
    body.push(`<row r="1"><c r="A1" s="3" t="inlineStr"><is><t>${escapeXml(caption)}</t></is></c></row>`);
  }

  body.push(
    `<row r="${headerRow}" ht="22" customHeight="1">` +
      columns.map((column, index) => cell(`${columnName(index)}${headerRow}`, column.header, 1)).join('') +
      '</row>'
  );

  rows.forEach((row, rowIndex) => {
    const reference = headerRow + 1 + rowIndex;
    body.push(
      `<row r="${reference}">` +
        columns
          .map((column, index) => cell(`${columnName(index)}${reference}`, column.value(row), 2))
          .join('') +
        '</row>'
    );
  });

  const lastColumn = columnName(Math.max(columns.length - 1, 0));
  const lastRow = headerRow + rows.length;

  /*
   * 목록 상자.
   *
   * 고를 값을 수식 안에 그대로 적습니다("대표,실장,팀장"). 별도 시트에 값을
   * 두고 참조하는 방법이 더 정석이지만, 시트가 하나 더 생기면 양식을 받는
   * 사람이 그 시트를 지우거나 고쳐서 목록이 깨집니다. 값이 몇 개뿐이라
   * 수식에 넣는 편이 튼튼합니다(엑셀 한계는 255자).
   *
   * 빈 양식에도 걸어 두려면 아직 없는 줄까지 범위를 잡아야 합니다.
   */
  const validationLastRow = headerRow + Math.max(rows.length, options.choiceRows ?? 200);
  const validations = (options.choices ?? [])
    .map((choice) => {
      const index = columns.findIndex((column) => column.header === choice.header);
      if (index < 0 || choice.options.length === 0) return '';
      const at = columnName(index);
      const list = escapeXml(choice.options.join(','));
      return (
        `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1"` +
        ` errorTitle="${escapeXml(choice.header)}" error="${escapeXml(
          `목록에서 골라 주세요: ${choice.options.join(' / ')}`
        )}"` +
        ` sqref="${at}${headerRow + 1}:${at}${validationLastRow}">` +
        `<formula1>"${list}"</formula1></dataValidation>`
      );
    })
    .filter(Boolean);

  const validationXml =
    validations.length > 0
      ? `<dataValidations count="${validations.length}">${validations.join('')}</dataValidations>`
      : '';

  const sheet =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetPr><outlinePr summaryBelow="1" summaryRight="1"/></sheetPr>' +
    `<dimension ref="A1:${lastColumn}${Math.max(lastRow, headerRow)}"/>` +
    // 머리글 아래를 고정합니다 — 수백 줄을 스크롤할 때 열 이름이 남아 있어야 합니다.
    '<sheetViews><sheetView workbookViewId="0" tabSelected="1">' +
    `<pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/>` +
    '</sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="16.5"/>' +
    '<cols>' +
    columns
      .map(
        (column, index) =>
          `<col min="${index + 1}" max="${index + 1}" width="${
            column.width ?? Math.min(Math.max(column.header.length * 2 + 4, 10), 60)
          }" customWidth="1"/>`
      )
      .join('') +
    '</cols>' +
    `<sheetData>${body.join('')}</sheetData>` +
    // 자동 필터를 걸어 두면 받는 사람이 바로 정렬·필터할 수 있습니다.
    (rows.length > 0 ? `<autoFilter ref="A${headerRow}:${lastColumn}${lastRow}"/>` : '') +
    validationXml +
    '</worksheet>';

  const styles =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="3">' +
    '<font><sz val="11"/><name val="맑은 고딕"/></font>' +
    '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="맑은 고딕"/></font>' +
    '<font><b/><sz val="13"/><color rgb="FF1E293B"/><name val="맑은 고딕"/></font>' +
    '</fonts>' +
    '<fills count="3">' +
    '<fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FF2563EB"/><bgColor indexed="64"/></patternFill></fill>' +
    '</fills>' +
    '<borders count="2">' +
    '<border><left/><right/><top/><bottom/><diagonal/></border>' +
    '<border><left style="thin"><color rgb="FFE2E8F0"/></left><right style="thin"><color rgb="FFE2E8F0"/></right>' +
    '<top style="thin"><color rgb="FFE2E8F0"/></top><bottom style="thin"><color rgb="FFE2E8F0"/></bottom><diagonal/></border>' +
    '</borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="4">' +
    '<xf xfId="0" fontId="0" fillId="0" borderId="0"/>' +
    // 1 = 머리글, 2 = 본문, 3 = 설명 줄
    '<xf xfId="0" fontId="1" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
    '<xf xfId="0" fontId="0" fillId="0" borderId="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' +
    '<xf xfId="0" fontId="2" fillId="0" borderId="0" applyFont="1"/>' +
    '</cellXfs>' +
    '</styleSheet>';

  return zip([
    {
      name: '[Content_Types].xml',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>` +
        '</workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>',
    },
    { name: 'xl/styles.xml', content: styles },
    { name: 'xl/worksheets/sheet1.xml', content: sheet },
  ]);
}
