import zlib from 'zlib';

/**
 * Minimal .xlsx and CSV reader.
 *
 * Written by hand rather than pulled from npm. An .xlsx file is a ZIP of XML
 * parts, and Node already ships the only hard part (raw DEFLATE, in zlib), so
 * the whole job is a few hundred lines. Against that, a spreadsheet library is
 * a megabyte of code and a supply-chain surface for what amounts to "read a
 * rectangle of text out of the first sheet".
 *
 * The scope is deliberately narrow: the first worksheet, as strings, with dates
 * normalised. It is not a general Excel implementation and does not try to be —
 * formulas are read as their cached values and everything else is ignored.
 */

export interface SheetTable {
  /** First row, treated as the header. Blank headers become "열 3" and so on. */
  headers: string[];
  /** Remaining rows, aligned to headers by position. */
  rows: string[][];
  /** Non-fatal observations worth showing the person importing the file. */
  warnings: string[];
}

/* ------------------------------------------------------------------ */
/* ZIP                                                                 */
/* ------------------------------------------------------------------ */

const SIGNATURE_CENTRAL = 0x02014b50;
const SIGNATURE_END = 0x06054b50;
/** A spreadsheet that inflates to more than this is not an order sheet. */
const MAX_INFLATED_BYTES = 64 * 1024 * 1024;

/**
 * Reads the archive by walking the central directory backwards from the end,
 * which is how a ZIP is meant to be read — scanning forward for local headers
 * misreads any entry whose sizes live in a trailing data descriptor.
 */
function unzip(buffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();

  // The end-of-central-directory record is last, but a trailing comment can
  // push it back by up to 64KB, so scan backwards for its signature.
  let end = -1;
  for (let i = buffer.length - 22; i >= 0 && i >= buffer.length - 22 - 0xffff; i -= 1) {
    if (buffer.readUInt32LE(i) === SIGNATURE_END) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('엑셀 파일 형식이 아닙니다. (ZIP 구조를 찾지 못했습니다)');

  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  let total = 0;

  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== SIGNATURE_CENTRAL) break;

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf-8', offset + 46, offset + 46 + nameLength);

    total += uncompressedSize;
    if (total > MAX_INFLATED_BYTES) throw new Error('엑셀 파일이 너무 큽니다.');

    // The local header repeats the name and extra fields, and its extra-field
    // length often differs from the central one — so it must be read here
    // rather than assumed.
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const body = buffer.subarray(start, start + compressedSize);

    if (!name.endsWith('/')) {
      try {
        entries.set(name, method === 0 ? Buffer.from(body) : zlib.inflateRawSync(body));
      } catch {
        // One unreadable part must not lose the rest; the caller reports the
        // absence of the part it actually needed.
      }
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/* XML                                                                 */
/* ------------------------------------------------------------------ */

const XML_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

function decodeXml(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (match, code: string) => {
    if (code.startsWith('#x') || code.startsWith('#X')) {
      return String.fromCodePoint(parseInt(code.slice(2), 16));
    }
    if (code.startsWith('#')) return String.fromCodePoint(Number(code.slice(1)));
    return XML_ENTITIES[code] ?? match;
  });
}

/** Every occurrence of one element, as its raw inner XML. */
function elements(xml: string, tag: string): string[] {
  const found: string[] = [];
    // Attributes are matched lazily. Greedy [^>]* swallows the closing slash of a
  // self-closing tag — <c r="I18" s="31"/> — so the pattern falls through to the
  // ">" branch and scans on into the *next* element. The result is not a parse
  // error but something worse: one cell silently carrying the contents of the
  // cells that follow it.
  const pattern = new RegExp(`<${tag}(\\s[^>]*?)?(/>|>([\\s\\S]*?)</${tag}>)`, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml))) found.push(match[3] ?? '');
  return found;
}

function attribute(fragment: string, name: string): string {
  const match = new RegExp(`${name}="([^"]*)"`).exec(fragment);
  return match ? decodeXml(match[1]) : '';
}

/** Concatenated text of every <t> in a fragment — rich-text runs included. */
function textOf(fragment: string): string {
  return elements(fragment, 't').map(decodeXml).join('');
}

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

/** Built-in numFmt ids that mean a date or a date-time. */
const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/**
 * Excel keeps dates as a day count, so a cell reading "2026-08-27" arrives as
 * 46261. Only the cell's number format says which it is, which is why styles
 * have to be read at all.
 *
 * The epoch is 1899-12-30, not 12-31, because Excel deliberately reproduces a
 * Lotus 1-2-3 bug that treats 1900 as a leap year.
 */
function excelSerialToDate(serial: number): string {
  // 1 은 1900-01-01, 2958465 는 9999-12-31. 이 범위 밖의 숫자는 날짜가 아닙니다 —
  // 송장번호(8.12e12)처럼 큰 값이 날짜 서식을 달고 있는 칸이 실제로 있고,
  // 그대로 계산하면 Date 가 Invalid 가 되어 toISOString 이 예외를 던집니다.
  if (!Number.isFinite(serial) || serial < 1 || serial > 2_958_465) return '';

  const date = new Date(Math.round((serial - 25569) * 86400 * 1000));
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

/** Style index → whether that style formats its number as a date. */
function dateStyles(stylesXml: string): Set<number> {
  const custom = new Set<number>();
  for (const fragment of stylesXml.match(/<numFmt\b[^>]*?\/>/g) || []) {
    const code = attribute(fragment, 'formatCode');
    // A format containing y/d, or m outside a time context, renders a date.
    if (/[yd]/i.test(code) || /\bm{3,}\b/i.test(code)) {
      custom.add(Number(attribute(fragment, 'numFmtId')));
    }
  }

  const dateIndexes = new Set<number>();
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml);
  const rows = cellXfs ? cellXfs[1].match(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g) || [] : [];
  rows.forEach((fragment, index) => {
    const id = Number(attribute(fragment, 'numFmtId'));
    if (DATE_FORMAT_IDS.has(id) || custom.has(id)) dateIndexes.add(index);
  });
  return dateIndexes;
}

/* ------------------------------------------------------------------ */
/* Sheet                                                               */
/* ------------------------------------------------------------------ */

/** "BC12" → 54. Column letters are base-26 with A = 1. */
function columnIndex(reference: string): number {
  const letters = /^([A-Z]+)/.exec(reference.toUpperCase());
  if (!letters) return 0;
  let index = 0;
  for (const character of letters[1]) index = index * 26 + (character.charCodeAt(0) - 64);
  return index - 1;
}

function readSharedStrings(xml: string): string[] {
  return elements(xml, 'si').map(textOf);
}

/** Reads one worksheet into a rectangle of strings. */
function readSheet(xml: string, shared: string[], dateIndexes: Set<number>): string[][] {
  const grid: string[][] = [];

  for (const rowXml of xml.match(/<row\b[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g) || []) {
    const cells: string[] = [];
    for (const cellXml of rowXml.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []) {
      const head = /^<c\b[^>]*?(?=\/?>)/.exec(cellXml)?.[0] ?? '';
      const type = attribute(head, 't');
      const styleAttribute = /s="(\d+)"/.exec(head);
      const at = columnIndex(attribute(head, 'r'));

      let value = '';
      if (type === 's') {
        const index = Number(elements(cellXml, 'v')[0] ?? '');
        value = shared[index] ?? '';
      } else if (type === 'inlineStr') {
        value = textOf(cellXml);
      } else if (type === 'str' || type === 'e') {
        value = decodeXml(elements(cellXml, 'v')[0] ?? '');
      } else {
        const raw = elements(cellXml, 'v')[0] ?? '';
        const numeric = Number(raw);
        const styled = styleAttribute ? dateIndexes.has(Number(styleAttribute[1])) : false;
        value = raw !== '' && styled && Number.isFinite(numeric)
          ? excelSerialToDate(numeric)
          : decodeXml(raw);
      }

      // Cells are addressed, not necessarily contiguous — an empty cell is
      // simply absent from the XML, so the gap has to be filled by position.
      while (cells.length < at) cells.push('');
      cells[at] = value.trim();
    }
    grid.push(cells);
  }
  return grid;
}

/* ------------------------------------------------------------------ */
/* Public                                                              */
/* ------------------------------------------------------------------ */

/**
 * Finds the row that is actually the header.
 *
 * Real order sheets do not start with their header. This one opens with seven
 * rows of colour legend and standing instructions ("시공전 / 시공완료 / 취소",
 * "수도권 발주진행 하루에 4개씩…") and only reaches 순번 / 주문자명 / 배송 주소
 * on row 8. Taking the first non-empty row would map every column to a note.
 *
 * The header is the row carrying the most short text labels: notes are long,
 * data rows contain numbers and addresses, and a header is a dense run of brief
 * words. Ties go to the earliest row.
 */
function findHeaderRow(rows: string[][]): number {
  const LABEL_MAX = 40;
  const searchDepth = Math.min(rows.length, 30);
  let best = 0;
  let bestScore = -1;

  for (let index = 0; index < searchDepth; index += 1) {
    const row = rows[index] ?? [];
    const labels = row.filter(
      (cell) => cell !== '' && cell.length <= LABEL_MAX && !/^-?[\d.,]+$/.test(cell)
    ).length;
    // A header must also have something underneath it.
    const filledBelow = (rows[index + 1] ?? []).filter((cell) => cell !== '').length;
    const score = labels + Math.min(filledBelow, 3);
    if (labels >= 3 && score > bestScore) {
      bestScore = score;
      best = index;
    }
  }
  return best;
}

/** Trims blank rows, finds the header row, and squares the rectangle. */
export function toTable(grid: string[][], warnings: string[] = []): SheetTable {
  const rows = grid.filter((row) => row.some((cell) => cell !== ''));
  if (rows.length === 0) return { headers: [], rows: [], warnings: [...warnings, '내용이 없는 파일입니다.'] };

  const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0);
  const squared = rows.map((row) => {
    const padded = [...row];
    while (padded.length < width) padded.push('');
    return padded;
  });

  const headerIndex = findHeaderRow(squared);
  if (headerIndex > 0) {
    warnings.push(`${headerIndex}줄의 안내문을 건너뛰고 ${headerIndex + 1}번째 줄을 항목 이름으로 읽었습니다.`);
  }
  // 머리글은 이름으로 열을 찾는 열쇠입니다. 같은 이름이 둘이면 indexOf 가 늘
  // 첫 번째를 집어, 뒤쪽 열은 아예 고를 수 없게 됩니다. 실제 주문서에는 "비고"
  // 가 두 개 있고 필요한 값은 두 번째에 있었습니다 — 그래서 이름을 고유하게
  // 만들어 둡니다. 화면에는 "비고 (2)" 로 보입니다.
  const seen = new Map<string, number>();
  const raw = squared[headerIndex]!.map((value, index) => value || `열 ${index + 1}`);
  const headers = raw.map((name) => {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    return count === 1 ? name : `${name} (${count})`;
  });
  const duplicated = [...seen.entries()].filter(([, count]) => count > 1).map(([name]) => name);
  if (duplicated.length) {
    warnings.push(
      `같은 이름의 열이 있어 뒤쪽에 번호를 붙였습니다: ${duplicated.join(', ')}`
    );
  }
  return { headers, rows: squared.slice(headerIndex + 1), warnings };
}

export interface WorkbookSheet {
  /** 시트 이름. 주문서에서는 이것이 현장종류가 됩니다. */
  name: string;
  table: SheetTable;
}

/**
 * 통합문서의 모든 시트를 읽습니다.
 *
 * 주문서는 현장(거래처)별로 시트를 나눠 씁니다 — "롯데백화점(흥주부)" 처럼요.
 * 그래서 시트 이름 자체가 데이터이고, 첫 시트만 읽으면 나머지 현장이 통째로
 * 사라집니다.
 */
export function parseWorkbook(buffer: Buffer): WorkbookSheet[] {
  const parts = unzip(buffer);
  const workbook = parts.get('xl/workbook.xml')?.toString('utf-8') ?? '';
  const relationships = parts.get('xl/_rels/workbook.xml.rels')?.toString('utf-8') ?? '';

  const targets = new Map<string, string>();
  for (const fragment of relationships.match(/<Relationship\b[^>]*?\/>/g) || []) {
    targets.set(attribute(fragment, 'Id'), attribute(fragment, 'Target'));
  }

  const shared = readSharedStrings(parts.get('xl/sharedStrings.xml')?.toString('utf-8') ?? '');
  const styles = dateStyles(parts.get('xl/styles.xml')?.toString('utf-8') ?? '');
  const sheets: WorkbookSheet[] = [];

  const tags = workbook.match(/<sheet\b[^>]*?\/>/g) || [];
  tags.forEach((tag, index) => {
    // 숨긴 시트는 대개 계산용 보조 시트입니다. 주문 목록이 아닙니다.
    if (/state="(hidden|veryHidden)"/i.test(tag)) return;

    const target = targets.get(attribute(tag, 'r:id')) || '';
    const path = target
      ? `xl/${target.replace(/^\/?xl\//, '').replace(/^\//, '')}`
      : `xl/worksheets/sheet${index + 1}.xml`;
    const part = parts.get(path);
    if (!part) return;

    sheets.push({
      name: attribute(tag, 'name') || `시트${index + 1}`,
      table: toTable(readSheet(part.toString('utf-8'), shared, styles), []),
    });
  });

  if (sheets.length === 0) throw new Error('엑셀 파일에서 시트를 찾지 못했습니다.');
  return sheets;
}

export function parseXlsx(buffer: Buffer): SheetTable {
  const parts = unzip(buffer);
  const warnings: string[] = [];

  // The workbook lists sheets in display order; the relationship file maps each
  // to its part. Reading sheet1.xml directly is wrong whenever sheets were
  // reordered or deleted, which is common in a working order sheet.
  const workbook = parts.get('xl/workbook.xml')?.toString('utf-8') ?? '';
  const sheetTags = workbook.match(/<sheet\b[^>]*?\/>/g) || [];
  const firstSheet = sheetTags[0] ?? '';
  if (sheetTags.length > 1) {
    warnings.push(`시트가 ${sheetTags.length}개입니다. 첫 번째 시트 "${attribute(firstSheet, 'name')}" 만 읽었습니다.`);
  }

  const relationships = parts.get('xl/_rels/workbook.xml.rels')?.toString('utf-8') ?? '';
  const relationshipId = firstSheet ? attribute(firstSheet, 'r:id') : '';
  let target = '';
  for (const fragment of relationships.match(/<Relationship\b[^>]*?\/>/g) || []) {
    if (attribute(fragment, 'Id') === relationshipId) target = attribute(fragment, 'Target');
  }
  const sheetPath = target
    ? `xl/${target.replace(/^\/?xl\//, '').replace(/^\//, '')}`
    : 'xl/worksheets/sheet1.xml';

  const sheetPart = parts.get(sheetPath) ?? parts.get('xl/worksheets/sheet1.xml');
  if (!sheetPart) throw new Error('엑셀 파일에서 시트를 찾지 못했습니다.');
  const sheetXml = sheetPart.toString('utf-8');

  const shared = readSharedStrings(parts.get('xl/sharedStrings.xml')?.toString('utf-8') ?? '');
  const styles = dateStyles(parts.get('xl/styles.xml')?.toString('utf-8') ?? '');
  return toTable(readSheet(sheetXml, shared, styles), warnings);
}

/**
 * Reads a delimited file. Handles quoted fields containing the delimiter,
 * newlines and doubled quotes, because an address column reliably contains at
 * least one of the three.
 */
export function parseDelimited(text: string, delimiter = ','): SheetTable {
  const grid: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  const endField = () => { row.push(field.trim()); field = ''; };
  const endRow = () => { endField(); grid.push(row); row = []; };

  const body = text.replace(/^﻿/, '');
  for (let i = 0; i < body.length; i += 1) {
    const character = body[i];
    if (quoted) {
      if (character === '"') {
        if (body[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += character;
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (character === delimiter) { endField(); continue; }
    if (character === '\n') { endRow(); continue; }
    if (character === '\r') continue;
    field += character;
  }
  if (field !== '' || row.length > 0) endRow();

  return toTable(grid, []);
}

/** Picks the delimiter by which one yields the most columns on the header row. */
export function parseCsv(text: string): SheetTable {
  const header = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? '';
  const best = [',', '\t', ';'].reduce(
    (winner, delimiter) => {
      const count = header.split(delimiter).length;
      return count > winner.count ? { delimiter, count } : winner;
    },
    { delimiter: ',', count: 0 }
  );
  return parseDelimited(text, best.delimiter);
}
