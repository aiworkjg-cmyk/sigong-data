import crypto from 'crypto';
import { addressParts, sourceKeyFor } from './order-import';
import { cleanText } from './util';
import type { Repositories, WorkOrderFilter } from './repositories';
import type {
  WorkOrder,
  WorkOrderDraft,
  WorkOrderGroup,
  WorkOrderImportResult,
  WorkOrderSource,
  WorkOrderStatus,
} from '../src/types';

export class WorkOrderError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = 'WorkOrderError';
  }
}

/**
 * 두 주문이 실질적으로 같은지.
 *
 * updatedAt 과 id 는 비교하지 않습니다 — 전자는 매번 달라지고 후자는 같은
 * 건인지 판정하는 기준이 아니라 결과입니다.
 */
function sameOrder(left: WorkOrder, right: WorkOrder): boolean {
  const fields: Array<keyof WorkOrder> = [
    'constructionType', 'siteType', 'technicianName', 'orderNumber', 'customerName',
    'phone', 'address', 'scheduledDate', 'region', 'regionGroup', 'building', 'notes', 'status',
    'incomplete',
  ];
  if (fields.some((field) => (left[field] ?? '') !== (right[field] ?? ''))) return false;
  return JSON.stringify(left.extras ?? []) === JSON.stringify(right.extras ?? []);
}

/** 한 번에 등록할 수 있는 주문 수. 주문서 한 장의 현실적인 상한입니다. */
const MAX_IMPORT_ROWS = 2000;

/**
 * 시공 예정 현장 목록.
 *
 * The point of this service is to move data entry off the person standing at
 * the site. Previously a technician typed the address, the date and the
 * customer on a phone, in the field — which is where transcription mistakes
 * come from and why the same building was filed under three spellings. Here the
 * office loads the order sheet once and the technician only picks a row.
 */
export class WorkOrderService {
  constructor(private readonly repos: Repositories) {}

  async list(filter: WorkOrderFilter = {}) {
    return this.repos.workOrders.list(filter);
  }

  async get(id: string): Promise<WorkOrder> {
    const order = await this.repos.workOrders.get(id);
    if (!order) throw new WorkOrderError('등록되지 않은 시공건입니다.', 404);
    return order;
  }

  /**
   * 기사 화면용 목록 — 날짜 → 지역으로 묶습니다.
   *
   * Grouped on the server so every caller sees the same ordering, and because
   * the grouping keys (지역 in particular) are derived from the address by the
   * same parser that builds folder names. Doing it in the browser would let the
   * list and the eventual folder disagree.
   */
  async grouped(filter: WorkOrderFilter): Promise<WorkOrderGroup[]> {
    /*
     * 제출이 끝난 건도 목록에 남깁니다.
     *
     * 예전에는 감췄습니다. 그런데 다른 기사가 실수로 남의 건을 골라 올리는
     * 일이 실제로 생기고, 그러면 정작 그 현장을 다녀온 기사에게는 자기 건이
     * 목록에서 사라져 버립니다. 그 기사는 직접 입력으로 넘어가고, 같은 현장이
     * 두 가지 표기로 저장됩니다 — 목록을 만든 이유가 무너집니다.
     *
     * 그래서 남기되 "업로드 완료" 로 눈에 띄게 표시하고, 그대로 다시 고를 수
     * 있게 합니다. 두 번째 제출은 폴더가 겹치지 않도록 별도 폴더로 저장됩니다
     * (SharePointService.avoidCollision).
     *
     * 취소된 건만 제외합니다.
     */
    const { items } = await this.repos.workOrders.list({
      ...filter,
      limit: filter.limit ?? 500,
    });

    const byDate = new Map<string, Map<string, WorkOrder[]>>();
    for (const order of items) {
      if (order.status === 'CANCELLED') continue;
      const dateKey = order.scheduledDate || '날짜 미정';
      const regionKey = order.region || '지역 미상';
      if (!byDate.has(dateKey)) byDate.set(dateKey, new Map());
      const regions = byDate.get(dateKey)!;
      if (!regions.has(regionKey)) regions.set(regionKey, []);
      regions.get(regionKey)!.push(order);
    }

    return [...byDate.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([scheduledDate, regions]) => ({
        scheduledDate,
        regions: [...regions.entries()]
          .sort(([left], [right]) => left.localeCompare(right, 'ko'))
          .map(([region, orders]) => ({
            region,
            orders: orders.sort((a, b) =>
              (a.building || a.address).localeCompare(b.building || b.address, 'ko')
            ),
          })),
      }));
  }

  /** 등록된 주문이 있는 시공종류와 각 건수. 기사 화면의 첫 단계입니다. */
  async summary(constructionTypes?: string[]): Promise<Array<{ constructionType: string; open: number }>> {
    const { items } = await this.repos.workOrders.list({
      status: 'OPEN',
      constructionTypes,
      limit: 2000,
    });
    const counts = new Map<string, number>();
    for (const order of items) {
      counts.set(order.constructionType, (counts.get(order.constructionType) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([constructionType, open]) => ({ constructionType, open }))
      .sort((a, b) => a.constructionType.localeCompare(b.constructionType, 'ko'));
  }

  /* ---------------------------------------------------------------- */
  /* 등록                                                               */
  /* ---------------------------------------------------------------- */

  /**
   * Commits reviewed rows.
   *
   * A row whose source identity already exists updates that order rather than
   * adding a second one — the office re-sends a corrected sheet far more often
   * than it sends a genuinely new order, and a duplicate is worse than a stale
   * value because two technicians can then claim the same job.
   *
   * Fields a person edited on screen are never overwritten by a later sync; see
   * WorkOrder.editedFields.
   */
  async importDrafts(input: {
    drafts: WorkOrderDraft[];
    source: WorkOrderSource;
    createdBy: string;
    knownTypes: string[];
    /** Sheet sync passes false so hand corrections survive the next poll. */
    overwriteEdited?: boolean;
    /** 시트 연동에서 온 경우 그 연동의 ID. removeMissing 의 범위가 됩니다. */
    sourceLinkId?: string;
  }): Promise<WorkOrderImportResult> {
    if (input.drafts.length > MAX_IMPORT_ROWS) {
      throw new WorkOrderError(`한 번에 등록할 수 있는 주문은 ${MAX_IMPORT_ROWS}건까지입니다.`);
    }

    const result: WorkOrderImportResult = {
      created: 0, updated: 0, unchanged: 0, skipped: 0, failed: [],
    };
    const seen = new Set<string>();

    for (const draft of input.drafts) {
      try {
        // 취소된 주문은 기사 목록에 뜨면 안 됩니다. 등록 자체를 하지 않습니다.
        if (draft.cancelled) {
          result.skipped += 1;
          continue;
        }
        const prepared = this.normalizeDraft(draft, input.knownTypes);
        const sourceKey = sourceKeyFor({ source: input.source, ...prepared });

        // Two rows of one sheet describing the same job: take the first and say
        // so, rather than letting the second silently overwrite it.
        if (seen.has(sourceKey)) {
          result.skipped += 1;
          continue;
        }
        seen.add(sourceKey);

        const existing = await this.repos.workOrders.findBySourceKey(sourceKey);
        const parts = addressParts(prepared.address);
        const now = new Date().toISOString();

        if (existing) {
          // A finished job is history. Re-importing the sheet it came from must
          // not reopen it and put it back in front of a technician.
          if (existing.status === 'SUBMITTED') {
            result.skipped += 1;
            continue;
          }
          const protectedFields = input.overwriteEdited ? [] : existing.editedFields;
          const keep = <K extends keyof WorkOrder>(field: K, incoming: WorkOrder[K]) =>
            protectedFields.includes(field as string) ? existing[field] : incoming;

          const next: WorkOrder = {
            ...existing,
            // 소유권은 먼저 가져온 시트에 둡니다. 두 시트에 같은 건이 있어도
            // 주인이 매번 바뀌면 두 연동이 10분마다 서로 갱신했다고 보고합니다.
            sourceLinkId: existing.sourceLinkId || input.sourceLinkId,
            constructionType: keep('constructionType', prepared.constructionType),
            siteType: keep('siteType', prepared.siteType || existing.siteType),
            technicianName: keep('technicianName', prepared.technicianName || existing.technicianName),
            incomplete: draft.incomplete || undefined,
            rowIndex: draft.rowIndex ?? existing.rowIndex,
            orderNumber: keep('orderNumber', prepared.orderNumber || undefined),
            customerName: keep('customerName', prepared.customerName),
            phone: keep('phone', prepared.phone || undefined),
            address: keep('address', prepared.address),
            scheduledDate: keep('scheduledDate', prepared.scheduledDate),
            region: keep('region', parts.region),
            regionGroup: parts.regionGroup,
            building: keep('building', parts.building || undefined),
            notes: keep('notes', prepared.notes || undefined),
            extras: draft.extras || existing.extras,
          };

          // 실제로 달라진 것이 없으면 저장도, 집계도 하지 않습니다.
          //
          // 이전에는 같은 건을 찾기만 하면 "갱신"으로 셌습니다. 10분마다 도는
          // 시트 동기화가 매번 "갱신 14건"을 보고했고, 기록 목록이 똑같은 줄로
          // 가득 차 정작 무언가 바뀐 회차를 찾을 수 없었습니다. updatedAt 은
          // 비교에서 빼야 합니다 — 그것만 매번 달라지기 때문입니다.
          // sourceLinkId 는 sameOrder 의 비교 항목이 아닙니다 — 주문 내용이
          // 아니기 때문입니다. 하지만 이전 버전에서 만들어져 비어 있는 건은
          // 여기서 주인을 채워 두어야 다음 동기화의 삭제 범위에 들어옵니다.
          if (sameOrder(existing, next) && next.sourceLinkId === existing.sourceLinkId) {
            result.unchanged += 1;
            continue;
          }

          await this.repos.workOrders.save({ ...next, updatedAt: now });
          result.updated += 1;
          continue;
        }

        await this.repos.workOrders.save({
          id: `ORDER-${now.slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(4).toString('hex')}`,
          constructionType: prepared.constructionType,
          siteType: prepared.siteType || undefined,
          technicianName: prepared.technicianName || undefined,
          incomplete: draft.incomplete || undefined,
          rowIndex: draft.rowIndex,
          orderNumber: prepared.orderNumber || undefined,
          customerName: prepared.customerName,
          phone: prepared.phone || undefined,
          address: prepared.address,
          scheduledDate: prepared.scheduledDate,
          region: parts.region,
          regionGroup: parts.regionGroup,
          building: parts.building || undefined,
          notes: prepared.notes || undefined,
          extras: draft.extras || [],
          status: 'OPEN',
          source: input.source,
          sourceKey,
          sourceLinkId: input.sourceLinkId,
          editedFields: [],
          createdAt: now,
          createdBy: input.createdBy,
          updatedAt: now,
        });
        result.created += 1;
      } catch (err) {
        result.failed.push({
          rowKey: draft.rowKey,
          message: err instanceof Error ? err.message : '알 수 없는 오류',
        });
      }
    }
    result.keys = [...seen];
    return result;
  }

  /**
   * 시트에서 사라진 주문건을 지웁니다.
   *
   * 주문서가 원본이고 이 시스템은 그 사본입니다. 시트에서 지운 줄이 여기 남아
   * 있으면 기사 목록에 없는 현장이 뜨고, 시트를 고쳐도 화면이 안 바뀌니 결국
   * 아무도 목록을 믿지 않게 됩니다. 그래서 매 동기화마다 시트에 있는 것만
   * 남깁니다.
   *
   * 단, **제출 완료된 건은 남깁니다.** 이미 파일이 올라간 현장의 기록을 시트
   * 정리 한 번으로 지우는 것은 되돌릴 수 없는 손실입니다.
   *
   * 시트를 못 읽은 회차에는 절대 부르면 안 됩니다 — 빈 목록으로 이 함수를
   * 부르면 그 업체의 대기 건이 통째로 사라집니다. 호출부에서 막습니다.
   */
  async removeMissing(options: {
    constructionType: string;
    source: WorkOrderSource;
    keys: string[];
    /**
     * 이 연동이 가져온 건만 대상으로 합니다.
     *
     * 한 업체에 시트가 여러 개일 때 필요합니다 — 백조1 동기화가 백조2에서 온
     * 건까지 지우면, 두 목록이 주기마다 번갈아 사라집니다. 비워 두면 그
     * 시공종류의 같은 출처 전체가 대상입니다(시트가 하나뿐일 때 쓰는 값으로,
     * 예전 데이터나 해제된 연동이 남긴 건도 이때 함께 정리됩니다).
     */
    linkId?: string;
  }): Promise<number> {
    const keep = new Set(options.keys);
    const { items } = await this.repos.workOrders.list({
      constructionTypes: [options.constructionType],
      limit: MAX_IMPORT_ROWS,
    });

    // 한 번에 지웁니다. 한 건씩 지우면 JSON 저장소가 그때마다 파일 전체를
    // 다시 써서, 백 건이 사라지는 회차에 파일 잠금 충돌이 납니다.
    const doomed = items
      .filter(
        (order) =>
          order.source === options.source &&
          order.status !== 'SUBMITTED' &&
          (!options.linkId || order.sourceLinkId === options.linkId) &&
          !keep.has(order.sourceKey)
      )
      .map((order) => order.id);

    await this.repos.workOrders.removeMany(doomed);
    return doomed.length;
  }

  /** Validates one reviewed row into the shape the store expects. */
  private normalizeDraft(draft: WorkOrderDraft, knownTypes: string[]) {
    const constructionType = cleanText(draft.constructionType, 40);
    const address = cleanText(draft.address, 300);
    const scheduledDate = cleanText(draft.scheduledDate, 10);

    if (!constructionType) throw new WorkOrderError('시공종류가 없습니다.');
    if (knownTypes.length && !knownTypes.includes(constructionType)) {
      throw new WorkOrderError(`등록되지 않은 시공종류입니다: ${constructionType}`);
    }
    // 주소는 필수가 아닙니다. 비어 있으면 폴더 이름이 "미지정"이 될 뿐이고,
    // 그것 때문에 파일 업로드 자체가 막히는 편이 훨씬 나쁩니다.
    // 날짜 없이도 저장됩니다 — 목록에서 "날짜 미정" 으로 묶입니다.
    if (scheduledDate && !/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)) {
      throw new WorkOrderError('시공예정일은 YYYY-MM-DD 형식이어야 합니다.');
    }

    return {
      constructionType,
      siteType: cleanText(draft.siteType, 60),
      technicianName: cleanText(draft.technicianName, 40),
      orderNumber: cleanText(draft.orderNumber, 60),
      customerName: cleanText(draft.customerName, 60),
      phone: cleanText(draft.phone, 20),
      address,
      scheduledDate,
      notes: cleanText(draft.notes, 500),
    };
  }

  /* ---------------------------------------------------------------- */
  /* 수정 · 상태                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Edits one order by hand, remembering which fields were touched so a later
   * sheet sync leaves them alone.
   */
  async update(id: string, patch: Partial<WorkOrder>, knownTypes: string[]): Promise<WorkOrder> {
    const existing = await this.get(id);
    const editable = [
      'constructionType', 'orderNumber', 'customerName', 'phone',
      'address', 'scheduledDate', 'notes',
    ] as const;

    const next: WorkOrder = { ...existing };
    const edited = new Set(existing.editedFields);

    for (const field of editable) {
      const incoming = patch[field];
      if (incoming === undefined) continue;
      const value = cleanText(String(incoming), field === 'address' ? 300 : 100);
      if (value === (existing[field] ?? '')) continue;
      (next as any)[field] = value || undefined;
      edited.add(field);
    }

    if (!next.constructionType || (knownTypes.length && !knownTypes.includes(next.constructionType))) {
      throw new WorkOrderError('등록된 시공종류를 선택해 주세요.');
    }
    if (next.scheduledDate && !/^\d{4}-\d{2}-\d{2}$/.test(next.scheduledDate)) {
      throw new WorkOrderError('시공예정일 형식이 올바르지 않습니다.');
    }

    const parts = addressParts(next.address);
    next.region = parts.region;
    next.regionGroup = parts.regionGroup;
    next.building = parts.building || undefined;
    next.editedFields = [...edited];
    next.updatedAt = new Date().toISOString();

    await this.repos.workOrders.save(next);
    return next;
  }

  async setStatus(id: string, status: WorkOrderStatus): Promise<WorkOrder> {
    const existing = await this.get(id);
    const next: WorkOrder = { ...existing, status, updatedAt: new Date().toISOString() };
    // Reopening detaches the submission; leaving the link would make the order
    // claim a site whose files it no longer accounts for.
    if (status === 'OPEN') {
      next.siteId = undefined;
      next.submittedAt = undefined;
    }
    await this.repos.workOrders.save(next);
    return next;
  }

  async remove(id: string): Promise<void> {
    await this.get(id);
    await this.repos.workOrders.remove(id);
  }

  /**
   * Marks an order done once its files are accepted.
   *
   * Never throws: the submission has already been accepted and its files staged
   * by the time this runs, so failing here must not turn a stored submission
   * into a failed one. A missed link shows up as an order still listed as open,
   * which an admin can close by hand — far better than losing the upload.
   */
  async markSubmitted(id: string, siteId: string): Promise<void> {
    try {
      const existing = await this.repos.workOrders.get(id);
      if (!existing) return;
      await this.repos.workOrders.save({
        ...existing,
        status: 'SUBMITTED',
        siteId,
        submittedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`[orders] 제출 완료 표시 실패 (${id})`, err);
    }
  }
}
