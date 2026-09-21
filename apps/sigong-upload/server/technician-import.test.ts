import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { parseCsv, parseXlsx } from './spreadsheet';
import { validateTechnicianImport, TECHNICIAN_HEADERS } from './technician-import';
import { SettingsService } from './settings';
import { encodeSettingsValue, decodeSettingsValue } from './repositories/settings-value';

const csv = (data: string) => parseCsv(`${TECHNICIAN_HEADERS.join(',')}\n${data}`);
function repo() {
 const values = new Map([['constructionTypes', '["백조","한샘"]']]);
 return { get: async (key: string) => values.get(key) ?? null, set: async (key: string, value: string) => { values.set(key, value); } };
}
test('다운로드할 실제 XLSX 양식은 다섯 열이며 예시 기사를 포함하지 않는다', () => {
 const table = parseXlsx(fs.readFileSync(new URL('../public/templates/시공기사_등록양식.xlsx', import.meta.url)));
 assert.deepEqual(table.headers, TECHNICIAN_HEADERS);
 assert.equal(table.rows.length, 0);
});
test('전화번호 앞자리와 복수 시공종류를 보존하고 빈 행 이후 오류 위치를 표시한다', () => {
 const table = csv('홍길동,팀장,"백조,한샘",010-1234-5678,경기\n\n김기사,없는직책,백조,,');
 const result = validateTechnicianImport(table, [], ['백조','한샘']);
 assert.equal(result.rows[0].phone, '010-1234-5678');
 assert.deepEqual(result.rows[0].constructionTypes, ['백조','한샘']);
 assert.match(result.errors[0], /^4행/);
 assert.match(validateTechnicianImport(csv('홍길동,팀장,한샘,,'), [], ['백조']).errors[0], /권한/);
});
test('작성 안내 시트가 포함된 실제 XLSX에 작성한 기사 정보를 읽는다', () => {
 const table = parseXlsx(fs.readFileSync(new URL('./fixtures/technicians-filled.xlsx', import.meta.url)));
 const result = validateTechnicianImport(table, [], ['백조','한샘']);
 assert.deepEqual(result.errors, []);
 assert.equal(result.rows[0].name, '테스트기사');
 assert.equal(result.rows[0].phone, '010-0000-1234');
 assert.deepEqual(result.rows[0].constructionTypes,['백조','한샘']);
});
test('중복, 잘못된 값은 전부 저장하지 않고 성공한 배치는 재시작 후 유지한다', async () => {
 const store = repo(); const settings = new SettingsService(store); await settings.load();
 await assert.rejects(settings.importTechnicians(csv('홍길동,팀장,백조,,\n김기사,사장,백조,,'), ['백조'], 'admin'), /직책/);
 assert.equal(settings.technicians().length, 0);
 assert.equal(await settings.importTechnicians(csv('홍길동,팀장,백조,010-1234-5678,경기'), ['백조'], 'admin'), 1);
 await assert.rejects(settings.importTechnicians(csv('홍길동,팀장,백조,,'), ['백조'], 'admin'), /중복/);
 const reloaded = new SettingsService(store); await reloaded.load();
 assert.equal(reloaded.technicians()[0].phone, '010-1234-5678');
});
test('저장 실패 시 명부가 바뀌지 않으며 동시에 같은 파일을 등록해도 중복이 없다', async () => {
 const store = repo(); const settings = new SettingsService(store); await settings.load();
 const original = store.set;
 store.set = async () => { throw new Error('저장 장애'); };
 await assert.rejects(settings.importTechnicians(csv('홍길동,팀장,백조,,'), ['백조'], 'admin'), /저장 장애/);
 assert.equal(settings.technicians().length, 0);
 store.set = original;
 const results = await Promise.allSettled([1,2].map(() => settings.importTechnicians(csv('홍길동,팀장,백조,,'), ['백조'], 'admin')));
 assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
 assert.equal(settings.technicians().length, 1);
});
test('Azure 문자열 속성 제한을 넘는 500명 명부도 하나의 엔터티로 왕복한다', () => {
 const value = JSON.stringify(Array.from({length:500}, (_, i) => ({id:`tech-${i}`,name:`기사${i}`,title:'팀장',constructionTypes:['백조'],phone:'010-1234-5678',region:'경기도 광명시',createdAt:'2026-09-10T00:00:00Z',createdBy:'admin'})));
 const encoded = encodeSettingsValue(value);
 assert.ok(Number(encoded.valuePartCount) > 1);
 for (const part of Object.values(encoded)) if (typeof part === 'string') assert.ok(Buffer.byteLength(part, 'utf16le') < 65536);
 assert.equal(decodeSettingsValue(encoded), value);
 assert.equal(decodeSettingsValue({value:'old'}), 'old');
});
