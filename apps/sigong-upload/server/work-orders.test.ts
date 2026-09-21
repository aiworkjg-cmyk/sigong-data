import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkOrderService } from './work-orders';
import type { Repositories, WorkOrderFilter } from './repositories';
import type { WorkOrder, WorkOrderDraft } from '../src/types';

class MemoryWorkOrders {
  items: WorkOrder[] = [];

  async list(filter: WorkOrderFilter = {}) {
    const { matchesWorkOrderFilter } = await import('./repositories');
    return {
      items: this.items
        .filter((order) => matchesWorkOrderFilter(order, filter))
        .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate)),
    };
  }
  async get(id: string) { return this.items.find((order) => order.id === id) ?? null; }
  async findBySourceKey(key: string) { return this.items.find((order) => order.sourceKey === key) ?? null; }
  async save(order: WorkOrder) {
    const index = this.items.findIndex((entry) => entry.id === order.id);
    if (index >= 0) this.items[index] = order; else this.items.push(order);
  }
  async remove(id: string) { this.items = this.items.filter((order) => order.id !== id); }
  async removeMany(ids: string[]) {
    const doomed = new Set(ids);
    this.items = this.items.filter((order) => !doomed.has(order.id));
  }
}

function serviceWith(): { service: WorkOrderService; store: MemoryWorkOrders } {
  const store = new MemoryWorkOrders();
  return { service: new WorkOrderService({ workOrders: store } as unknown as Repositories), store };
}

function draft(over: Partial<WorkOrderDraft> = {}): WorkOrderDraft {
  return {
    rowKey: 'row-2',
    constructionType: '백조',
    siteType: '',
    technicianName: '',
    orderNumber: 'A-1024',
    customerName: '홍길동',
    phone: '010-1234-5678',
    address: '경기도 광명시 하안동 e편한세상 101동 1502호',
    scheduledDate: '2026-09-01',
    notes: '',
    extras: [],
    problems: [],
    ...over,
  };
}

const TYPES = ['백조', '인덕션'];

test('주문서를 다시 올려도 같은 건은 새로 만들지 않고 갱신한다', async () => {
  const { service, store } = serviceWith();

  const first = await service.importDrafts({
    drafts: [draft()], source: 'EXCEL', createdBy: '관리자', knownTypes: TYPES,
  });
  assert.deepEqual([first.created, first.updated], [1, 0]);

  // 사무실에서 주소를 고쳐 같은 주문번호로 다시 보내온 경우.
  const again = await service.importDrafts({
    drafts: [draft({ address: '경기도 광명시 하안동 e편한세상 101동 1503호' })],
    source: 'EXCEL', createdBy: '관리자', knownTypes: TYPES, overwriteEdited: true,
  });
  assert.deepEqual([again.created, again.updated], [0, 1]);
  assert.equal(store.items.length, 1);
  assert.ok(store.items[0]?.address.endsWith('1503호'));
  // 주소에서 뽑은 지역·건물명이 함께 갱신되어야 목록의 묶음이 어긋나지 않습니다.
  assert.equal(store.items[0]?.region, '경기도 광명시');
});

test('한 파일 안의 같은 건 두 줄은 하나만 등록하고 건너뛴 수를 알려준다', async () => {
  const { service, store } = serviceWith();
  const result = await service.importDrafts({
    drafts: [draft(), draft({ rowKey: 'row-3' })],
    source: 'EXCEL', createdBy: '관리자', knownTypes: TYPES,
  });
  assert.deepEqual([result.created, result.skipped], [1, 1]);
  assert.equal(store.items.length, 1);
});

test('사람이 고친 항목은 시트 재동기화가 덮어쓰지 않는다', async () => {
  const { service, store } = serviceWith();
  await service.importDrafts({
    drafts: [draft()], source: 'GOOGLE_SHEET', createdBy: 'sheet', knownTypes: TYPES,
  });

  // 현장에서 확인한 정확한 주소로 관리자가 직접 수정.
  const id = store.items[0]!.id;
  await service.update(id, { address: '경기도 광명시 하안동 광명아크포레 205동 1102호' }, TYPES);

  // 시트에는 여전히 옛 주소가 있지만, 손댄 항목이므로 되돌아가면 안 됩니다.
  await service.importDrafts({
    drafts: [draft()], source: 'GOOGLE_SHEET', createdBy: 'sheet',
    knownTypes: TYPES, overwriteEdited: false,
  });
  assert.ok(store.items[0]?.address.includes('광명아크포레'));
  // 손대지 않은 항목은 시트를 따라갑니다.
  assert.equal(store.items[0]?.customerName, '홍길동');
});

test('제출이 끝난 건은 주문서를 다시 올려도 되살아나지 않는다', async () => {
  const { service, store } = serviceWith();
  await service.importDrafts({
    drafts: [draft()], source: 'EXCEL', createdBy: '관리자', knownTypes: TYPES,
  });
  await service.markSubmitted(store.items[0]!.id, 'BAEKJO-20260901-001');
  assert.equal(store.items[0]?.status, 'SUBMITTED');

  const again = await service.importDrafts({
    drafts: [draft()], source: 'EXCEL', createdBy: '관리자', knownTypes: TYPES,
  });
  assert.deepEqual([again.created, again.updated, again.skipped], [0, 0, 1]);
  assert.equal(store.items[0]?.status, 'SUBMITTED');
});

test('등록되지 않은 시공종류나 빠진 값은 그 줄만 실패로 남긴다', async () => {
  const { service, store } = serviceWith();
  const result = await service.importDrafts({
    drafts: [
      draft(),
      draft({ rowKey: 'row-3', orderNumber: 'A-2', constructionType: '없는종류' }),
      draft({ rowKey: 'row-4', orderNumber: 'A-3', address: '' }),
    ],
    source: 'EXCEL', createdBy: '관리자', knownTypes: TYPES,
  });
  // 한 줄이 틀렸다고 나머지가 통째로 버려지면 안 됩니다.
  // 등록을 막는 것은 시공종류뿐입니다 — 주소가 없는 줄(row-4)도 그대로 등록되고,
  // 폴더 이름에서만 "미지정"이 됩니다. 파일 업로드가 1순위입니다.
  assert.equal(result.created, 2);
  assert.deepEqual(result.failed.map((entry) => entry.rowKey), ['row-3']);
  assert.equal(store.items.length, 2);
  assert.equal(store.items.find((order) => order.orderNumber === 'A-3')?.address, '');
});

test('기사 화면 목록은 날짜 → 지역으로 묶이고 제출된 건도 남는다', async () => {
  const { service, store } = serviceWith();
  await service.importDrafts({
    drafts: [
      draft({ orderNumber: 'A-1', address: '경기도 광명시 하안동 e편한세상', scheduledDate: '2026-09-01' }),
      draft({ rowKey: 'r3', orderNumber: 'A-2', address: '경기도 광명시 소하동 현대아파트', scheduledDate: '2026-09-01' }),
      draft({ rowKey: 'r4', orderNumber: 'A-3', address: '서울특별시 강남구 역삼동 래미안', scheduledDate: '2026-09-01' }),
      draft({ rowKey: 'r5', orderNumber: 'A-4', address: '서울특별시 강남구 삼성동 아이파크', scheduledDate: '2026-09-02' }),
    ],
    source: 'EXCEL', createdBy: '관리자', knownTypes: TYPES,
  });

  const submitted = store.items.find((order) => order.orderNumber === 'A-3')!;
  await service.markSubmitted(submitted.id, 'SITE-1');

  const groups = await service.grouped({ constructionTypes: ['백조'] });
  assert.deepEqual(groups.map((group) => group.scheduledDate), ['2026-09-01', '2026-09-02']);

  const firstDay = groups[0]!;
  // 제출이 끝난 건도 남습니다 — 다른 기사가 잘못 올렸을 때 정작 그 현장을
  // 다녀온 기사가 자기 건을 못 찾는 일을 막기 위해서입니다. 대신 상태로
  // 구분되어 화면에서 "업로드 완료" 로 표시됩니다.
  assert.deepEqual(
    firstDay.regions.map((entry) => entry.region),
    ['경기도 광명시', '서울특별시 강남구']
  );
  assert.equal(firstDay.regions[0]?.orders.length, 2);
  assert.equal(
    firstDay.regions.find((entry) => entry.region === '서울특별시 강남구')?.orders[0]?.status,
    'SUBMITTED'
  );

  const summary = await service.summary();
  assert.deepEqual(summary, [{ constructionType: '백조', open: 3 }]);
});

test('시공예정일이 비어 있어도 등록되고 "날짜 미정" 으로 묶인다', async () => {
  const { service, store } = serviceWith();
  const result = await service.importDrafts({
    drafts: [draft({ orderNumber: 'A-9', scheduledDate: '' })],
    source: 'EXCEL', createdBy: '관리자', knownTypes: TYPES,
  });
  assert.equal(result.created, 1);
  assert.equal(store.items[0]?.scheduledDate, '');

  const groups = await service.grouped({ constructionTypes: ['백조'] });
  assert.deepEqual(groups.map((group) => group.scheduledDate), ['날짜 미정']);
});

test('주문서의 현장종류와 담당 기사를 그대로 보관한다', async () => {
  const { service, store } = serviceWith();
  await service.importDrafts({
    drafts: [draft({ siteType: '롯데백화점(흥주부)', technicianName: '유동현 팀장' })],
    source: 'EXCEL', createdBy: '관리자', knownTypes: TYPES,
  });
  // 현장종류는 시트 이름에서, 기사는 "26.05.25 / 유동현 팀장" 칸에서 옵니다.
  assert.equal(store.items[0]?.siteType, '롯데백화점(흥주부)');
  assert.equal(store.items[0]?.technicianName, '유동현 팀장');
});

test('같은 업체에 시트가 둘이면 한쪽 동기화가 다른 쪽 주문을 지우지 않는다', async () => {
  const { service, store } = serviceWith();

  const first = await service.importDrafts({
    drafts: [draft({ orderNumber: 'B1-1' })],
    source: 'GOOGLE_SHEET', createdBy: 'sheet:백조1', knownTypes: TYPES,
    sourceLinkId: 'sheet-1',
  });
  await service.importDrafts({
    drafts: [draft({ orderNumber: 'B2-1', address: '서울특별시 강남구 역삼동 12-3' })],
    source: 'GOOGLE_SHEET', createdBy: 'sheet:백조2', knownTypes: TYPES,
    sourceLinkId: 'sheet-2',
  });
  assert.equal(store.items.length, 2);

  // 백조1 만 돌아간 회차. 백조2 의 건은 이 시트에 없는 것이 정상입니다.
  const removed = await service.removeMissing({
    constructionType: '백조', source: 'GOOGLE_SHEET', keys: first.keys ?? [], linkId: 'sheet-1',
  });

  assert.equal(removed, 0);
  assert.equal(store.items.length, 2);
  assert.deepEqual(
    store.items.map((order) => order.sourceLinkId).sort(),
    ['sheet-1', 'sheet-2']
  );
});

test('시트가 하나뿐이면 시트에서 사라진 건을 지운다', async () => {
  const { service, store } = serviceWith();

  await service.importDrafts({
    drafts: [draft({ orderNumber: 'B1-1' }), draft({ orderNumber: 'B1-2', rowKey: 'row-3' })],
    source: 'GOOGLE_SHEET', createdBy: 'sheet:백조1', knownTypes: TYPES,
    sourceLinkId: 'sheet-1',
  });

  // 둘째 줄이 시트에서 지워진 회차 — linkId 를 넘기지 않으면 예전 데이터까지
  // 포함해 그 업체의 시트 출처 전체가 대상입니다.
  const again = await service.importDrafts({
    drafts: [draft({ orderNumber: 'B1-1' })],
    source: 'GOOGLE_SHEET', createdBy: 'sheet:백조1', knownTypes: TYPES,
    sourceLinkId: 'sheet-1',
  });
  const removed = await service.removeMissing({
    constructionType: '백조', source: 'GOOGLE_SHEET', keys: again.keys ?? [],
  });

  assert.equal(removed, 1);
  assert.equal(store.items.length, 1);
  assert.equal(store.items[0]?.orderNumber, 'B1-1');
});
