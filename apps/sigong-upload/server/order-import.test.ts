import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'zlib';
import { parseAddress } from '@jg/sharepoint-core';
import { regionGroupOf } from '../src/region';
import { parseCsv, parseWorkbook, parseXlsx } from './spreadsheet';
import { buildWorkbook } from './xlsx-writer';
import { buildDrafts, detectMapping, looksCancelled, normalizeDate, sourceKeyFor } from './order-import';

/* ------------------------------------------------------------------ */
/* A real .xlsx, built by hand                                         */
/* ------------------------------------------------------------------ */

/**
 * Builds a ZIP the way Excel does, so the reader is exercised against the
 * structure it will actually meet rather than a convenient stand-in.
 */
function zip(files: Array<{ name: string; content: string }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf-8');
    const raw = Buffer.from(file.content, 'utf-8');
    const deflated = zlib.deflateRawSync(raw);
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, deflated);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + deflated.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([Buffer.concat(locals), centralBuffer, end]);
}

function crc32(buffer: Buffer): number {
  let crc = -1;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}

function workbook(): Buffer {
  const shared = [
    '주문번호', '주문자', '시공주소', '시공예정일', '연락처', '비고',
    'A-1024', '홍길동', '경기도 광명시 하안동 e편한세상 101동 1502호', '010-1234-5678', '오전 방문',
    'A-1025', '김철수', '서울특별시 강남구 역삼동 e편한세상 3동 201호',
  ];
  return zip([
    {
      name: 'xl/workbook.xml',
      content: `<workbook><sheets><sheet name="주문" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      content: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
    },
    {
      name: 'xl/sharedStrings.xml',
      content: `<sst>${shared.map((value) => `<si><t>${value}</t></si>`).join('')}</sst>`,
    },
    {
      // Style 1 carries numFmtId 14 — a built-in date format.
      name: 'xl/styles.xml',
      content: `<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      content: `<worksheet><sheetData>
<row r="1">
  <c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c>
  <c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c><c r="F1" t="s"><v>5</v></c>
</row>
<row r="2">
  <c r="A2" t="s"><v>6</v></c><c r="B2" t="s"><v>7</v></c><c r="C2" t="s"><v>8</v></c>
  <c r="D2" s="1"><v>46266</v></c><c r="E2" t="s"><v>9</v></c><c r="F2" t="s"><v>10</v></c>
</row>
<row r="3">
  <c r="A3" t="s"><v>11</v></c><c r="B3" t="s"><v>12</v></c><c r="C3" t="s"><v>13</v></c>
  <c r="D3" s="1"><v>46267</v></c>
</row>
</sheetData></worksheet>`,
    },
  ]);
}

test('엑셀 주문서를 읽어 머리글과 값을 그대로 돌려준다', () => {
  const table = parseXlsx(workbook());

  assert.deepEqual(table.headers, ['주문번호', '주문자', '시공주소', '시공예정일', '연락처', '비고']);
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[0]?.[1], '홍길동');
  // Excel stores a date as a day count; only the cell style says it is one.
  assert.equal(table.rows[0]?.[3], '2026-09-01');
  // A row that stops early is padded, not truncated — otherwise the columns
  // after the gap would shift left onto the wrong headers.
  assert.equal(table.rows[1]?.length, 6);
  assert.equal(table.rows[1]?.[4], '');
});

test('열 이름이 달라도 어느 항목인지 알아본다', () => {
  const mapping = detectMapping(['주문 번호', '고객명', '현장주소', '설치일', '휴대폰', '요청사항']);
  assert.equal(mapping.orderNumber, '주문 번호');
  assert.equal(mapping.customerName, '고객명');
  assert.equal(mapping.address, '현장주소');
  assert.equal(mapping.scheduledDate, '설치일');
  assert.equal(mapping.phone, '휴대폰');
  assert.equal(mapping.notes, '요청사항');
});

test('"주문번호" 열이 "주문자" 항목에 먼저 잡히지 않는다', () => {
  // Exact matches are claimed before any substring match, so 주문번호 cannot be
  // taken by customerName on the shared prefix.
  const mapping = detectMapping(['주문번호', '주문자', '주소', '시공일']);
  assert.equal(mapping.orderNumber, '주문번호');
  assert.equal(mapping.customerName, '주문자');
});

test('사람이 쓰는 여러 날짜 표기를 하나로 정리한다', () => {
  assert.equal(normalizeDate('2026-09-01'), '2026-09-01');
  assert.equal(normalizeDate('2026.9.1'), '2026-09-01');
  assert.equal(normalizeDate('2026년 9월 1일'), '2026-09-01');
  assert.equal(normalizeDate('26/09/01'), '2026-09-01');
  assert.equal(normalizeDate('20260901'), '2026-09-01');
  // 2월 31일 같은 값은 조용히 3월 3일이 되지 않고 거부됩니다.
  assert.equal(normalizeDate('2026-02-31'), '');
  assert.equal(normalizeDate('내일'), '');
});

test('연결한 열로 확인용 줄을 만들고, 고쳐야 할 곳을 표시한다', () => {
  const table = parseCsv(
    '주문번호,주문자,시공주소,시공예정일,담당지점\n' +
      'A-1,홍길동,"경기도 광명시 하안동, 101동",2026-09-01,광명점\n' +
      'A-2,김철수,,2026-09-02,광명점\n' +
      'A-3,이영희,서울시 강남구,언제,광명점\n'
  );
  const drafts = buildDrafts({
    table,
    mapping: detectMapping(table.headers),
    defaultConstructionType: '백조',
    knownTypes: ['백조'],
  });

  assert.equal(drafts.length, 3);
  assert.deepEqual(drafts[0]?.problems, []);
  // A quoted field keeps its comma rather than splitting into two columns.
  assert.equal(drafts[0]?.address, '경기도 광명시 하안동, 101동');
  // An unmapped column is carried, not discarded.
  assert.deepEqual(drafts[0]?.extras, [{ label: '담당지점', value: '광명점' }]);

  // 주소가 비어도 문제로 잡지 않습니다. 폴더 이름이 "미지정"이 될 뿐이고,
  // 그 한 칸 때문에 현장에서 파일을 못 올리는 편이 훨씬 나쁩니다.
  assert.deepEqual(drafts[1]?.problems, []);
  assert.equal(drafts[1]?.address, '');
  // 날짜는 읽지 못한 사실 자체를 알려 줍니다 — 값이 있는데 해석이 안 된 경우입니다.
  assert.ok(drafts[2]?.problems.some((problem) => problem.includes('언제')));
});

test('주문번호가 있으면 재업로드해도 같은 건으로 알아본다', () => {
  const base = {
    source: 'EXCEL' as const,
    constructionType: '백조',
    address: '경기도 광명시 하안동',
    scheduledDate: '2026-09-01',
    customerName: '홍길동',
  };
  // 주소를 고쳐 다시 보내와도 주문번호가 같으면 같은 건입니다.
  assert.equal(
    sourceKeyFor({ ...base, orderNumber: 'A-1024' }),
    sourceKeyFor({ ...base, orderNumber: 'A-1024', address: '경기도 광명시 하안동 101동' })
  );
  // 주문번호가 없으면 종류·주소·날짜·주문자의 조합이 신원이 됩니다.
  assert.equal(
    sourceKeyFor({ ...base, orderNumber: '' }),
    sourceKeyFor({ ...base, orderNumber: '', address: '경기도  광명시 하안동' })
  );
  assert.notEqual(
    sourceKeyFor({ ...base, orderNumber: '' }),
    sourceKeyFor({ ...base, orderNumber: '', scheduledDate: '2026-09-02' })
  );
});

test('주소를 배차 단위의 권역으로 묶는다', () => {
  const cases: Array<[string, string]> = [
    // 서울은 수도권에 포함합니다 — 배차가 둘을 나눠서 이뤄지지 않습니다.
    ['서울 강남구 학동로77길 49', '수도권'],
    ['경기 김포시 고촌읍 태리로 236', '수도권'],
    ['인천 미추홀구 아암대로 118', '수도권'],
    ['충남 천안시 동남구 …', '충남'],
    ['대전 유성구 …', '충남'],
    ['부산 해운대구 …', '경남'],
    ['대구 수성구 …', '경북'],
    ['제주특별자치도 서귀포시 …', '제주'],
    // 알아보지 못하면 억지로 배정하지 않고 '기타'로 모읍니다 — 그래야 주소가
    // 이상하다는 사실이 필터에서 눈에 띕니다.
    ['', '기타'],
    ['우리집', '기타'],
  ];
  for (const [address, expected] of cases) {
    assert.equal(regionGroupOf(address), expected, address);
  }
});

test('주문상태가 취소인 줄은 등록에서 빠진다', () => {
  const table = parseCsv(
    '주문자,주소,시공예정일,비고\n' +
      '홍길동,서울 강남구,2026-09-01,5/13 상담 완료\n' +
      '김철수,서울 서초구,2026-09-01,가로 사이즈 불가로 취소 처리\n' +
      '이영희,서울 송파구,2026-09-01,본사 취소 요청\n' +
      '박민수,서울 마포구,2026-09-01,취소 요청 있었으나 진행하기로 함\n'
  );
  // 상태 전용 열이 없어도, 취소가 실제로 적힌 열을 찾아 제안합니다.
  const mapping = detectMapping(table.headers, table.rows);
  assert.equal(mapping.status, '비고');

  const drafts = buildDrafts({
    table, mapping, defaultConstructionType: '백조', knownTypes: ['백조'],
  });
  assert.deepEqual(drafts.map((row) => Boolean(row.cancelled)), [false, true, true, false]);
  // 뒤집는 말이 함께 있으면 취소로 보지 않습니다 — 사람이 판단할 몫입니다.
  assert.equal(drafts[3]?.cancelled, false);
});

test('같은 이름의 열이 둘이면 뒤쪽에 번호를 붙여 구분한다', () => {
  // 실제 주문서에 "비고"가 두 개 있었고, 필요한 값은 두 번째에 있었습니다.
  // 이름이 같으면 indexOf 가 늘 첫 번째를 집어 뒤쪽 열은 고를 수 없습니다.
  const table = parseCsv('주소,비고,시공예정일,비고\nA,메모1,2026-09-01,취소 처리\n');
  assert.deepEqual(table.headers, ['주소', '비고', '시공예정일', '비고 (2)']);

  const mapping = detectMapping(table.headers, table.rows);
  assert.equal(mapping.status, '비고 (2)');
  assert.equal(buildDrafts({
    table, mapping, defaultConstructionType: '백조', knownTypes: ['백조'],
  })[0]?.cancelled, true);
});

test('내보낸 엑셀을 다시 읽으면 같은 표가 나온다', () => {
  // 쓰기와 읽기가 서로를 검증합니다 — 둘 다 직접 만든 코드라, 한쪽만 맞고
  // 다른 쪽이 틀리면 실제 엑셀에서 열리지 않는 파일이 조용히 나갑니다.
  const rows = [
    { 이름: '홍길동', 주소: '경기 광명시 하안동 <101동>', 개수: 3 },
    { 이름: '김철수 & 이영희', 주소: '', 개수: 0 },
  ];
  const buffer = buildWorkbook({
    sheetName: '시공현황',
    caption: '조건: 2026-08 · 백조',
    columns: [
      { header: '이름', value: (r) => r.이름 },
      { header: '주소', value: (r) => r.주소 },
      { header: '개수', value: (r) => r.개수 },
    ],
    rows,
  });

  const [{ name, table }] = parseWorkbook(buffer);
  assert.equal(name, '시공현황');
  assert.deepEqual(table.headers, ['이름', '주소', '개수']);
  assert.equal(table.rows.length, 2);
  // XML 특수문자가 그대로 살아 돌아와야 합니다.
  assert.equal(table.rows[0]?.[1], '경기 광명시 하안동 <101동>');
  assert.equal(table.rows[1]?.[0], '김철수 & 이영희');
  assert.equal(table.rows[0]?.[2], '3');
});

test('시공완료·시공x 도 주문건에서 뺀다', () => {
  // 목록은 "지금 가서 자료를 올려야 하는 현장"입니다. 이미 끝난 건과 시공이
  // 없는 건은 거기에 들어갈 자리가 없습니다.
  const cancelled = ['취소 처리', '시공완료', '시공 완료', '시공x', '시공 X', '시공×', '반품 보냄'];
  for (const value of cancelled) {
    assert.equal(looksCancelled(value), true, value);
  }
  // 뒤집는 말이 함께 있으면 사람이 판단할 몫으로 남깁니다.
  assert.equal(looksCancelled('취소 요청 있었으나 진행하기로 함'), false);
  // 평범한 상담 메모까지 걸리면 안 됩니다.
  assert.equal(looksCancelled('5/13 상담 완료'), false);
  assert.equal(looksCancelled(''), false);
});

test('표준 한국 주소에서 지역과 건물명을 뽑는다', () => {
  // 실제 주문서에 들어 있는 형태입니다: 도로명 + (법정동, 아파트명) + 동호수.
  // 괄호가 가장 확실한 정보라 그것을 먼저 읽습니다.
  const parsed = parseAddress('경기 오산시 초평중앙로 65 (벌음동, 호반써밋라프리미어) 1904동902호');
  assert.equal(parsed.region, '경기 오산시');
  assert.equal(parsed.dong, '벌음동');
  assert.equal(parsed.building, '호반써밋라프리미어');
  assert.equal(parsed.short, '경기 오산시 호반써밋라프리미어');

  // 도로명이 시군구로 잘못 잡히면 안 됩니다 — "문시로" 에서 "문시" 를 떼어
  // "경기 오산시 문시" 라는 존재하지 않는 지역이 나오던 버그입니다.
  assert.equal(
    parseAddress('경기 오산시 문시로 183-19 (외삼미동, 서동탄역 더샵 파크시티) 113동 2403호').region,
    '경기 오산시'
  );
  // 구까지 두 단계인 경우.
  assert.equal(
    parseAddress('경기 수원시 권선구 권광로 55 (권선동, 권선자이 이편한세상) 117-1202').region,
    '경기 수원시 권선구'
  );
  // 공백이 전혀 없는 주소도 실제로 들어옵니다.
  const squeezed = parseAddress('경기도광명시소하동이편한세상107동1402호');
  assert.equal(squeezed.dong, '소하동');
  assert.equal(squeezed.building, '이편한세상');
  // 괄호가 없으면 도로명과 동호수를 걷어낸 나머지가 건물명입니다.
  assert.equal(
    parseAddress('경기 광명시 하안로 60 광명SK테크노파크 A동 702호').building,
    '광명SK테크노파크'
  );
});
