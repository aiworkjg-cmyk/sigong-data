import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CalendarDays,
  ChevronRight,
  Loader2,
  MapPin,
  PencilLine,
  RefreshCw,
  Search,
  XCircle,
} from 'lucide-react';
import { publicApi } from '../api';
import { maskName } from '../privacy';
import type { WorkOrder, WorkOrderGroup } from '../types';

interface WorkOrderPickerProps {
  constructionType: string;
  /** 고른 현장종류. 비어 있으면 이 시공종류의 모든 현장을 봅니다. */
  siteType?: string;
  /** 고른 시공일. 비어 있으면 모든 날짜를 보여줍니다. */
  scheduledDate: string;
  selected: WorkOrder | null;
  onSelect: (order: WorkOrder) => void;
  onClear: () => void;
  /** 목록에 없는 현장을 직접 입력으로 넘어갑니다. */
  onManualEntry: () => void;
}

/** "2026-09-01" → "9월 1일 (월)". 연도는 주변 맥락으로 충분합니다. */
function formatDay(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  const weekday = ['일', '월', '화', '수', '목', '금', '토'][date.getUTCDay()];
  return `${Number(match[2])}월 ${Number(match[3])}일 (${weekday})`;
}

/**
 * 시공건 고르기.
 *
 * 이 화면이 존재하는 이유는 입력을 없애는 것입니다. 예전에는 기사가 현장에 서서
 * 주소·주문자·날짜를 휴대폰으로 타이핑했고, 그래서 같은 건물이 세 가지 표기로
 * 저장됐습니다. 여기서는 사무실이 주문서로 한 번 넣은 값을 고르기만 합니다.
 *
 * 목록은 날짜(와 현장종류)로만 좁힙니다. 담당 기사로는 거르지 않습니다 —
 * 주문서의 기사명은 예정이고 실제로 간 사람이 다른 경우가 흔해서, 그걸로
 * 좁히면 대신 간 기사에게는 자기 현장이 없는 것처럼 보입니다. 그날 그 현장의
 * 건은 누가 열어도 다 보이고, 실제 시공기사는 제출할 때 따로 고릅니다.
 */
export const WorkOrderPicker: React.FC<WorkOrderPickerProps> = ({
  constructionType,
  siteType,
  scheduledDate,
  selected,
  onSelect,
  onClear,
  onManualEntry,
}) => {
  const [groups, setGroups] = useState<WorkOrderGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const load = useCallback(async () => {
    if (!constructionType) return;
    setLoading(true);
    setError(null);
    try {
      const { groups: found } = await publicApi.workOrders({
        constructionType,
        siteType,
        date: scheduledDate,
      });
      setGroups(found);
    } catch (err: any) {
      setError(err?.message || '시공건 목록을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [constructionType, siteType, scheduledDate]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 검색은 브라우저에서 합니다. 이 시점의 목록은 이미 몇 건 수준이고,
   * 신호가 약한 현장에서 글자마다 요청을 보내는 것보다 낫습니다.
   */
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase().replace(/\s+/g, '');
    if (!needle) return groups;
    return groups
      .map((group) => ({
        ...group,
        regions: group.regions
          .map((entry) => ({
            ...entry,
            orders: entry.orders.filter((order) =>
              [order.address, order.customerName, order.building, order.orderNumber, order.phone]
                .filter(Boolean)
                .join(' ')
                .toLowerCase()
                .replace(/\s+/g, '')
                .includes(needle)
            ),
          }))
          .filter((entry) => entry.orders.length > 0),
      }))
      .filter((group) => group.regions.length > 0);
  }, [groups, search]);

  const total = useMemo(
    () =>
      filtered.reduce(
        (sum, group) => sum + group.regions.reduce((inner, entry) => inner + entry.orders.length, 0),
        0
      ),
    [filtered]
  );

  /* ---------------------------------------------------------------- */

  if (selected) {
    return (
      <div className="rounded-2xl border-2 border-blue-500 bg-blue-50 p-4">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-bold text-blue-700 mb-1">선택한 시공건</p>
            <p className="text-base font-extrabold text-slate-900 break-keep">
              {selected.orderNumber || selected.building || '(주문번호 없음)'}
            </p>
            <p className="text-base font-extrabold text-slate-900 break-keep">
              {selected.address || '(주소 미정)'}
            </p>
            <dl className="mt-2 space-y-1">
              {([
                ['주문자명', maskName(selected.customerName)],
                ['시공예정자', selected.technicianName || ''],
                ['현장종류', selected.siteType || ''],
                ['시공일', selected.scheduledDate ? formatDay(selected.scheduledDate) : '미정'],
                // 주소는 위에 전체로 적습니다. 연락처는 여전히 보여 주지 않고
                // 이름은 끝자를 가립니다 — 이유는 privacy.ts 에 있습니다.
              ] as const)
                .filter(([, value]) => value)
                .map(([label, value]) => (
                  <div key={label} className="flex gap-2 text-xs">
                    <dt className="w-16 shrink-0 font-semibold text-slate-400">{label}</dt>
                    <dd className="font-semibold text-slate-800 break-all">{value}</dd>
                  </div>
                ))}
            </dl>
            {selected.notes && (
              <p className="mt-2 rounded-lg bg-white/70 px-2.5 py-1.5 text-xs text-slate-600">
                {selected.notes}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClear}
            className="shrink-0 px-3 py-2 rounded-lg border border-blue-300 bg-white text-xs font-bold text-blue-700"
          >
            다시 고르기
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="주소 · 아파트명 · 주문자로 찾기"
            // 모바일에서 16px 미만이면 iOS 가 포커스 시 화면을 확대합니다.
            className="w-full pl-9 pr-3 py-2.5 rounded-lg border border-slate-300 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          title="목록 새로고침"
          className="shrink-0 p-2.5 rounded-lg border border-slate-300 text-slate-500 disabled:opacity-50"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800 mb-3">
          <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {loading && groups.length === 0 && (
        <p className="py-8 text-center text-xs text-slate-400">목록을 불러오는 중…</p>
      )}

      {!loading && total === 0 && (
        <div className="py-5 text-center">
          <p className="text-sm font-bold text-slate-700">
            {search ? '검색 결과가 없습니다.' : '조건에 맞는 시공건이 없습니다.'}
          </p>
          {!search && (
            <p className="mt-2 text-xs text-slate-500">
              주문서에 아직 등록되지 않았을 수 있습니다. 아래 버튼으로 직접 입력해 주세요.
            </p>
          )}
        </div>
      )}

      <div className="space-y-3">
        {filtered.map((group) => (
          <div key={group.scheduledDate}>
            {/* 날짜를 이미 골랐다면 머리글은 한 줄이면 충분합니다. */}
            <p className="flex items-center gap-1.5 mb-1.5 text-xs font-bold text-slate-500">
              <CalendarDays className="w-3.5 h-3.5" />
              {group.scheduledDate === '날짜 미정' ? '날짜 미정' : formatDay(group.scheduledDate)}
              <span className="ml-auto px-1.5 py-0.5 rounded-full bg-slate-200 text-[10px] font-bold text-slate-600">
                {group.regions.reduce((sum, entry) => sum + entry.orders.length, 0)}건
              </span>
            </p>
            <div className="rounded-xl border border-slate-200 overflow-hidden">
              {group.regions.map((entry) => (
                <div key={entry.region}>
                  <p className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-50 text-[11px] font-bold text-slate-500">
                    <MapPin className="w-3 h-3" />
                    {entry.region}
                    <span className="text-slate-400">· {entry.orders.length}건</span>
                  </p>
                  <ul className="divide-y divide-slate-100">
                    {entry.orders.map((order, index) => (
                      <li key={order.id}>
                        <button
                          type="button"
                          onClick={() => onSelect(order)}
                          // 넉넉한 터치 영역: 장갑 낀 엄지로, 야외에서, 한 손으로 누릅니다.
                          // 이미 올라간 건은 짙은 파스텔 초록으로 구분하되, 누르는
                          // 것은 그대로 됩니다 — 남이 잘못 올린 경우 그 건으로
                          // 다시 올려야 하기 때문입니다.
                          className={`w-full flex items-start gap-3 px-3 py-3 text-left ${
                            order.status === 'SUBMITTED'
                              ? 'bg-emerald-200 hover:bg-emerald-300 active:bg-emerald-400'
                              : 'hover:bg-blue-50 active:bg-blue-100'
                          }`}
                        >
                          {/* 번호를 붙입니다. 줄만 나열하면 세 건인지 네 건인지
                              세어야 알 수 있고, 현장에서 급할수록 그 한 번의
                              세기가 실수로 이어집니다. */}
                          <span className="mt-0.5 shrink-0 w-6 h-6 grid place-items-center rounded-full bg-slate-100 text-[11px] font-bold text-slate-500">
                            {index + 1}
                          </span>
                          {/* 주문번호 · 주소가 굵게 두 줄, 사람 이름은 그 아래.
                              기사가 목록에서 찾는 것은 "내가 갈 그 집" 하나이고,
                              그것을 가르는 값이 주소입니다. 자르지 않습니다 —
                              같은 아파트의 다른 동이 같은 줄로 보이면 이 목록을
                              보는 의미가 없습니다. */}
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-bold text-slate-900 break-keep">
                              {order.orderNumber || order.building || '(주문번호 없음)'}
                              {order.status === 'SUBMITTED' && (
                                <span className="ml-1.5 px-1.5 py-0.5 rounded bg-emerald-600 text-[10px] font-bold text-white align-middle">
                                  업로드 완료
                                </span>
                              )}
                            </p>
                            <p className="text-sm font-bold text-slate-900 break-keep">
                              {order.address || '(주소 미정)'}
                            </p>
                            <p className="mt-0.5 text-[11px] text-slate-500 break-keep">
                              주문자명 : {maskName(order.customerName) || '—'}
                              {order.technicianName ? ` · 시공예정자 : ${order.technicianName}` : ''}
                            </p>
                          </div>
                          <ChevronRight className="w-4 h-4 text-slate-300 shrink-0" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* 눈에 잘 띄어야 합니다. 주문서 등록이 늦거나 급한 현장이 생겨도 작업이
          멈추면 안 되고, 기사가 이 버튼을 못 찾으면 그 자리에서 막힙니다. */}
      <button
        type="button"
        onClick={onManualEntry}
        className="mt-4 w-full flex items-center justify-center gap-2 px-4 py-3.5 rounded-xl border-2 border-amber-400 bg-amber-50 text-sm font-bold text-amber-900 hover:bg-amber-100 active:bg-amber-200"
      >
        <PencilLine className="w-4 h-4 shrink-0" />
        <span className="flex flex-col items-center leading-tight">
          <span className="whitespace-nowrap">주문건 목록에 없음</span>
          <span className="whitespace-nowrap">직접 입력하기</span>
        </span>
      </button>
    </div>
  );
};
