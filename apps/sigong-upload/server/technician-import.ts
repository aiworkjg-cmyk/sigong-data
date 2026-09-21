import { TECHNICIAN_TITLES, type Technician, type TechnicianTitle } from '../src/types';
import type { SheetTable } from './spreadsheet';

export const TECHNICIAN_HEADERS = ['이름', '직책', '시공종류', '연락처', '담당지역'];
export interface TechnicianInput {
  name: string; title: TechnicianTitle; constructionTypes: string[]; phone: string; region: string;
}
export function validateTechnicianImport(table: SheetTable, existing: Technician[], allowedTypes: string[]) {
  const errors: string[] = [];
  const rows: TechnicianInput[] = [];
  if (TECHNICIAN_HEADERS.some((header) => !table.headers.includes(header))) {
    return { rows, errors: ['양식의 열 이름을 확인해 주세요: 이름, 직책, 시공종류, 연락처, 담당지역'] };
  }
  // The distributed workbook has a second instruction sheet; only data from
  // the first sheet is imported, as explained next to the upload control.
  const blockingWarnings = table.warnings.filter((warning) => !/^시트가 \d+개입니다\. 첫 번째 시트/.test(warning));
  if (blockingWarnings.length) return { rows, errors: blockingWarnings };
  if (!table.rows.length || table.rows.length > 500) return { rows, errors: ['한 번에 1~500명의 기사 정보를 입력해 주세요.'] };
  const seen = new Set(existing.map((tech) => `${tech.name}\0${tech.title}`));
  table.rows.forEach((cells, index) => {
    const at = table.rowNumbers?.[index] ?? index + 2;
    const read = (header: string) => String(cells[table.headers.indexOf(header)] ?? '').trim().replace(/\s+/g, ' ');
    const name = read('이름'), title = read('직책'), phone = read('연락처'), region = read('담당지역');
    const constructionTypes = [...new Set(read('시공종류').split(/[,;，]/).map((value) => value.trim()).filter(Boolean))];
    const rowErrors: string[] = [];
    if (!name || name.length > 20) rowErrors.push('이름은 1~20자');
    if (!(TECHNICIAN_TITLES as readonly string[]).includes(title)) rowErrors.push(`직책은 ${TECHNICIAN_TITLES.join(' / ')}`);
    if (!constructionTypes.length) rowErrors.push('시공종류를 1개 이상 입력');
    if (constructionTypes.some((type) => !allowedTypes.includes(type))) rowErrors.push('등록되지 않았거나 권한이 없는 시공종류');
    if (phone.length > 20) rowErrors.push('연락처는 20자 이내');
    if (region.length > 40) rowErrors.push('담당지역은 40자 이내');
    const key = `${name}\0${title}`;
    if (seen.has(key)) rowErrors.push('같은 이름·직책이 이미 등록되어 있거나 파일에 중복됨');
    seen.add(key);
    if (rowErrors.length) errors.push(`${at}행 (${name || '이름 없음'}): ${rowErrors.join(', ')}`);
    else rows.push({ name, title: title as TechnicianTitle, phone, region, constructionTypes });
  });
  if (existing.length + table.rows.length > 500) errors.push('기존 명부와 합쳐 최대 500명까지 등록할 수 있습니다.');
  return { rows, errors };
}
