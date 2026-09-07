import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Loader2, RefreshCw, RotateCcw, Search, Trash2, X } from 'lucide-react';
import { adminApi } from '../api';
import { compareWorkOrders, normalizeRegionGroup, REGION_GROUPS, WORK_ORDER_SORTS } from '../types';
import type { WorkOrder, WorkOrderSort } from '../types';

interface WorkOrderTableProps {
  orders: WorkOrder[];
  /** 이 계정이 다룰 수 있는 시공종류. 필터 버튼이 됩니다. */
  allowedTypes: string[];
  onRefresh: () => void;
  onFeedback: (kind: 'ok' | 'error', text: string) => void;
}

const STATUS_LABELS: Record<WorkOrder['status'], string> = {
  OPEN: '대기',
  SUBMITTED: '제출 완료',
  CANCELLED: '취소',
};

/** 편집 가능한 항목. 일괄 수정에서도 같은 목록을 씁니다. */
const EDITABLE = [
  { field: 'scheduledDate', label: '시공일', type: 'date' },
  { field: 'technicianName', label: '담당기사', type: 'text' },
  { field: 'siteType', label: '현장종류', type: 'text' },
  { field: 'customerName', label: '주문자', type: 'text' },
  { field: 'phone', label: '연락처', type: 'text' },
  { field: 'address', label: '주소', type: 'text' },
] as const;

/**
 * 등록된 시공건 목록.
 *
 * 주문서 화면에서 떼어 왔습니다. 등록하는 일과 등록된 것을 관리하는 일은
 * 서로 다른 작업이고, 한 화면에 두면 주문서를 올리러 왔다가 목록을 스크롤해
 * 내려가야 합니다. 캘린더와 같은 탭에 두면 "언제 무엇이 있는가"를 두 가지
 * 방식으로 같은 자리에서 봅니다.
 *
 * 체크박스가 있는 이유: 시트에서 잘못 들어온 건은 대개 한 건이 아니라 무더기로
 * 들어옵니다. 한 줄씩 취소하게 하면 그 일을 아무도 하지 않습니다.
 */
export const WorkOrderTable: React.FC<WorkOrderTableProps> = ({
  orders,
  allowedTypes,
  onRefresh,
  onFeedback,
}) => {
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<WorkOrder['status'] | ''>('OPEN');
  const [types, setTypes] = useState<string[]>([]);
  const [siteType, setSiteType] = useState('');
  const [region, setRegion] = useState('');
  const [technician, setTechnician] = useState('');
  /** 값이 덜 채워진 건만 보기. 시트에서 미완성으로 들어온 것을 추려낼 때 씁니다. */
  const [incompleteOnly, setIncompleteOnly] = useState(false);
  /**
   * 기본은 시트 순서입니다.
   *
   * 이 목록을 여는 가장 흔한 이유가 원본 시트와 한 줄씩 대조하는 것이고,
   * 그때는 두 화면의 줄 순서가 같아야 눈으로 짚어 갈 수 있습니다.
   */
  const [sort, setSort] = useState<WorkOrderSort>('sheet');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** 일괄 수정 중인 항목과 값. 비어 있으면 수정창이 닫힌 상태입니다. */
  const [bulkField, setBulkField] = useState<(typeof EDITABLE)[number]['field'] | ''>('');
  const [bulkValue, setBulkValue] = useState('');
  const headerCheckbox = useRef<HTMLInputElement>(null);

  /**
   * 현장종류는 시공종류를 골라야 의미가 생깁니다.
   *
   * 백조는 현장(롯데백화점·현대목동…)마다 나누고 인덕션은 안 나눌 수 있어서,
   * 전체를 한 목록에 섞으면 고를 수 없는 조합이 잔뜩 생깁니다.
   */
  const siteTypeOptions = useMemo(() => {
    const pool = types.length > 0 ? orders.filter((o) => types.includes(o.constructionType)) : [];
    return [...new Set(pool.map((o) => o.siteType).filter(Boolean))].sort((a, b) =>
      String(a).localeCompare(String(b), 'ko')
    ) as string[];
  }, [orders, types]);

  const technicianOptions = useMemo(
    () =>
      [...new Set(orders.map((o) => o.technicianName).filter(Boolean))].sort((a, b) =>
        String(a).localeCompare(String(b), 'ko')
      ) as string[],
    [orders]
  );

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase().replace(/\s+/g, '');
    return orders.filter((order) => {
      if (status && order.status !== status) return false;
      if (types.length > 0 && !types.includes(order.constructionType)) return false;
      if (siteType && order.siteType !== siteType) return false;
      if (region && (normalizeRegionGroup(order.regionGroup)) !== region) return false;
      if (technician && !(order.technicianName || '').includes(technician)) return false;
      if (incompleteOnly && !order.incomplete) return false;
      if (!needle) return true;
      return [order.address, order.customerName, order.building, order.orderNumber, order.phone]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .replace(/\s+/g, '')
        .includes(needle);
    });
  }, [orders, status, types, siteType, region, technician, incompleteOnly, search]);

  const sorted = useMemo(() => [...visible].sort(compareWorkOrders(sort)), [visible, sort]);

  // 필터가 바뀌면 보이지 않는 줄의 선택은 풀어 둡니다 — 안 보이는 것을
  // 지우거나 고치는 일이 없어야 합니다.
  useEffect(() => {
    setSelected((current) => {
      const ids = new Set(visible.map((order) => order.id));
      const next = new Set([...current].filter((id) => ids.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [visible]);

  // 일부만 선택된 상태를 머리글 체크박스에 표시합니다.
  useEffect(() => {
    if (headerCheckbox.current) {
      headerCheckbox.current.indeterminate =
        selected.size > 0 && selected.size < visible.length;
    }
  }, [selected, visible.length]);

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () =>
    setSelected((current) =>
      current.size === visible.length ? new Set() : new Set(visible.map((order) => order.id))
    );

  const incompleteCount = useMemo(
    () => orders.filter((order) => order.incomplete).length,
    [orders]
  );

  const clearFilters = () => {
    setTypes([]);
    setSiteType('');
    setRegion('');
    setTechnician('');
    setSearch('');
    setStatus('');
    setIncompleteOnly(false);
  };

  /* ---------------------------------------------------------------- */
  /* 일괄 작업                                                          */
  /* ---------------------------------------------------------------- */

  const run = async (label: string, work: (id: string) => Promise<unknown>) => {
    const ids = [...selected];
    setBusy(true);
    let failed = 0;
    for (const id of ids) {
      try {
        await work(id);
      } catch {
        failed += 1;
      }
    }
    setBusy(false);
    setSelected(new Set());
    onRefresh();
    onFeedback(
      failed ? 'error' : 'ok',
      failed
        ? `${label} — ${ids.length - failed}건 완료, ${failed}건 실패`
        : `${ids.length}건 ${label}했습니다.`
    );
  };

  const bulkCancel = async () => {
    if (
      !window.confirm(
        `선택한 ${selected.size}건을 취소할까요?\n\n` +
          '기사 목록에서 사라집니다. 기록은 지워지지 않으며,\n' +
          '상태를 [취소]로 걸러 [되돌리기]로 복구할 수 있습니다.'
      )
    ) {
      return;
    }
    await run('취소', (id) => adminApi.setWorkOrderStatus(id, 'CANCELLED'));
  };

  const bulkReopen = () => void run('되돌리기', (id) => adminApi.setWorkOrderStatus(id, 'OPEN'));

  const bulkDelete = async () => {
    if (
      !window.confirm(
        `선택한 ${selected.size}건을 완전히 삭제할까요?\n\n` +
          '되돌릴 수 없습니다. 잠시 숨기려는 것이라면 [취소]를 쓰세요.'
      )
    ) {
      return;
    }
    await run('삭제', (id) => adminApi.removeWorkOrder(id));
  };

  const bulkEdit = async () => {
    if (!bulkField || !bulkValue.trim()) return;
    await run('수정', (id) => adminApi.updateWorkOrder(id, { [bulkField]: bulkValue.trim() }));
    setBulkField('');
    setBulkValue('');
  };

  /* ---------------------------------------------------------------- */

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h3 className="text-base font-bold text-slate-900">
          등록된 시공건
          <span className="ml-2 text-xs font-semibold text-slate-500">
            {visible.length}건{visible.length !== orders.length && ` / 전체 ${orders.length}건`}
          </span>
        </h3>
        <button
          type="button"
          onClick={onRefresh}
          className="p-2 rounded-lg border border-slate-300 text-slate-500"
          aria-label="새로고침"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* 시공종류는 버튼으로. 몇 개 안 되고 매번 바꾸는 조건이라 드롭다운보다
          한 번에 보이는 편이 낫습니다. */}
      <div className="flex flex-wrap items-center gap-1.5 mb-2">
        {allowedTypes.map((type) => {
          const on = types.includes(type);
          return (
            <button
              key={type}
              type="button"
              onClick={() => {
                setTypes((current) =>
                  current.includes(type) ? current.filter((t) => t !== type) : [...current, type]
                );
                setSiteType('');
              }}
              className={`px-3 py-1.5 rounded-lg border text-xs font-bold ${
                on
                  ? 'border-blue-500 bg-blue-600 text-white'
                  : 'border-slate-300 bg-white text-slate-600 hover:border-slate-400'
              }`}
            >
              {type}
            </button>
          );
        })}
        {types.length > 0 && (
          <button
            type="button"
            onClick={() => { setTypes([]); setSiteType(''); }}
            className="px-2 py-1.5 text-[11px] font-semibold text-slate-500 underline"
          >
            전체 시공종류
          </button>
        )}
      </div>

      {/* 현장종류는 시공종류를 고른 뒤에만 나옵니다. */}
      {siteTypeOptions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-2 pl-1">
          <span className="text-[11px] font-bold text-slate-400">현장종류</span>
          {siteTypeOptions.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setSiteType(siteType === name ? '' : name)}
              className={`px-2.5 py-1 rounded-md border text-[11px] font-semibold ${
                siteType === name
                  ? 'border-emerald-500 bg-emerald-600 text-white'
                  : 'border-slate-200 bg-slate-50 text-slate-600'
              }`}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value as WorkOrder['status'] | '')}
          className="px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs"
        >
          <option value="OPEN">대기 중</option>
          <option value="SUBMITTED">제출 완료</option>
          <option value="CANCELLED">취소됨</option>
          <option value="">전체 상태</option>
        </select>
        <select
          value={sort}
          onChange={(event) => setSort(event.target.value as WorkOrderSort)}
          className="px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs"
          aria-label="정렬 기준"
        >
          {WORK_ORDER_SORTS.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label}
            </option>
          ))}
        </select>
        {/* 미완성만. 등록은 됐지만 값이 빠진 건이라 따로 모아 볼 일이 잦습니다. */}
        <button
          type="button"
          onClick={() => setIncompleteOnly((on) => !on)}
          className={`px-2.5 py-1.5 rounded-lg border text-xs font-semibold ${
            incompleteOnly
              ? 'border-amber-500 bg-amber-100 text-amber-800'
              : 'border-slate-300 text-slate-600'
          }`}
        >
          미완성만
          {incompleteCount > 0 && <span className="ml-1 font-bold">{incompleteCount}</span>}
        </button>
        <select
          value={technician}
          onChange={(event) => setTechnician(event.target.value)}
          className="px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs"
        >
          <option value="">전체 기사</option>
          {technicianOptions.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        <select
          value={region}
          onChange={(event) => setRegion(event.target.value)}
          className="px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs"
        >
          <option value="">전체 권역</option>
          {REGION_GROUPS.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        <div className="relative flex-1 min-w-[160px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="주소 · 주문자 · 주문번호"
            className="w-full pl-8 pr-3 py-1.5 rounded-lg border border-slate-300 text-xs"
          />
        </div>
        {(types.length || siteType || region || technician || search || status !== 'OPEN') && (
          <button
            type="button"
            onClick={clearFilters}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs font-semibold text-slate-600"
          >
            <RotateCcw className="w-3 h-3" />
            전체보기
          </button>
        )}
      </div>

      {/* 선택했을 때만 나타납니다 — 평소에는 자리를 차지하지 않습니다. */}
      {selected.size > 0 && (
        <div className="sticky top-2 z-10 mb-3 rounded-xl border-2 border-blue-300 bg-blue-50 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold text-blue-900">{selected.size}건 선택됨</span>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="text-[11px] font-semibold text-blue-700 underline"
            >
              선택 해제
            </button>

            <span className="mx-1 text-blue-300">|</span>

            <select
              value={bulkField}
              onChange={(event) => {
                setBulkField(event.target.value as typeof bulkField);
                setBulkValue('');
              }}
              className="px-2 py-1.5 rounded-lg border border-blue-300 bg-white text-xs"
            >
              <option value="">일괄 수정할 항목…</option>
              {EDITABLE.map((entry) => (
                <option key={entry.field} value={entry.field}>{entry.label}</option>
              ))}
            </select>
            {bulkField && (
              <>
                <input
                  type={EDITABLE.find((e) => e.field === bulkField)?.type ?? 'text'}
                  value={bulkValue}
                  onChange={(event) => setBulkValue(event.target.value)}
                  placeholder="새 값"
                  className="px-2 py-1.5 rounded-lg border border-blue-300 text-xs"
                />
                <button
                  type="button"
                  onClick={() => void bulkEdit()}
                  disabled={busy || !bulkValue.trim()}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-bold disabled:opacity-50"
                >
                  {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                  적용
                </button>
              </>
            )}

            <span className="mx-1 text-blue-300">|</span>

            <button
              type="button"
              onClick={() => void bulkCancel()}
              disabled={busy}
              className="px-2.5 py-1.5 rounded-lg border border-slate-400 bg-white text-xs font-bold text-slate-700 disabled:opacity-50"
            >
              취소 처리
            </button>
            <button
              type="button"
              onClick={bulkReopen}
              disabled={busy}
              className="px-2.5 py-1.5 rounded-lg border border-blue-400 bg-white text-xs font-bold text-blue-700 disabled:opacity-50"
            >
              대기로 되돌리기
            </button>
            <button
              type="button"
              onClick={() => void bulkDelete()}
              disabled={busy}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-red-300 bg-white text-xs font-bold text-red-700 disabled:opacity-50"
            >
              <Trash2 className="w-3 h-3" />
              삭제
            </button>
          </div>
        </div>
      )}

      {visible.length === 0 ? (
        <p className="p-4 rounded-lg bg-slate-50 text-xs text-slate-500">
          조건에 맞는 시공건이 없습니다.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full text-xs">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-3 py-2 w-8">
                  <input
                    ref={headerCheckbox}
                    type="checkbox"
                    checked={selected.size > 0 && selected.size === visible.length}
                    onChange={toggleAll}
                    aria-label="전체 선택"
                  />
                </th>
                {['시공일', '시공종류', '현장종류', '권역', '현장', '주문자', '담당기사', '상태'].map(
                  (label) => (
                    <th key={label} className="px-3 py-2 text-left font-bold text-slate-500 whitespace-nowrap">
                      {label}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sorted.map((order) => {
                const checked = selected.has(order.id);
                return (
                  <tr key={order.id} className={checked ? 'bg-blue-50' : 'hover:bg-slate-50'}>
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(order.id)}
                        aria-label={`${order.building || order.address} 선택`}
                      />
                    </td>
                    <td className="px-3 py-2 font-semibold text-slate-700 whitespace-nowrap">
                      {order.scheduledDate || <span className="text-slate-400">미정</span>}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className="px-1.5 py-0.5 rounded bg-slate-100 text-[11px] font-bold text-slate-700">
                        {order.constructionType}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{order.siteType || '—'}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className="px-1.5 py-0.5 rounded bg-slate-100 text-[11px] text-slate-600">
                        {normalizeRegionGroup(order.regionGroup)}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <p className="font-semibold text-slate-900">
                        {order.building || order.address}
                        {/* 등록은 하되 눈에 띄게. 값이 빠진 채로 조용히 섞여 있으면
                            현장에서야 알아차리게 됩니다. */}
                        {order.incomplete && (
                          <span
                            title={order.incomplete}
                            className="ml-1.5 px-1.5 py-0.5 rounded bg-amber-100 text-[10px] font-bold text-amber-800 align-middle"
                          >
                            미완성
                          </span>
                        )}
                      </p>
                      {order.incomplete && (
                        <p className="text-[11px] text-amber-700">{order.incomplete}</p>
                      )}
                      {order.building && (
                        <p className="text-[11px] text-slate-400">{order.address}</p>
                      )}
                    </td>
                    <td className="px-3 py-2 text-slate-600 whitespace-nowrap">
                      {order.customerName || '—'}
                    </td>
                    <td className="px-3 py-2 text-slate-600 whitespace-nowrap">
                      {order.technicianName || '—'}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span
                        className={`inline-block px-2 py-0.5 rounded-md text-[11px] font-bold whitespace-nowrap ${
                          order.status === 'SUBMITTED'
                            ? 'bg-emerald-100 text-emerald-800'
                            : order.status === 'CANCELLED'
                              ? 'bg-slate-200 text-slate-600'
                              : 'bg-blue-100 text-blue-800'
                        }`}
                      >
                        {STATUS_LABELS[order.status]}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
