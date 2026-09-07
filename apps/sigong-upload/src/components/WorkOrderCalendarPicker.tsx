import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  MapPin,
  PencilLine,
  RefreshCw,
  Search,
  X,
  XCircle,
} from 'lucide-react';
import { publicApi } from '../api';
import { maskAddress, maskName } from '../privacy';
import type { WorkOrder, WorkOrderGroup } from '../types';

interface WorkOrderCalendarPickerProps {
  constructionType: string;
  siteType?: string;
  selected: WorkOrder | null;
  onSelect: (order: WorkOrder) => void;
  onClear: () => void;
  onManualEntry: () => void;
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

function ymd(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 그 달 격자에 들어갈 날들. 앞뒤 달의 자투리를 포함해 항상 일요일에서 시작합니다. */
function monthGrid(cursor: Date): Date[] {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay());
  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    return day;
  });
}

/**
 * 달력으로 시공건 고르기.
 *
 * 목록 방식과 무엇이 다른가: 기사는 "오늘/내일 어디를 가는지"를 날짜로 기억합니다.
 * 날짜 칸을 먼저 고르고 그 안에서 현장을 집는 편이, 날짜를 입력한 뒤 목록을
 * 훑는 것보다 그 기억의 순서와 맞습니다. 대신 한 화면에 담기는 정보가 적어서
 * 건수가 많은 업체에는 목록 쪽이 낫습니다 — 그래서 둘을 두고 고르게 합니다.
 *
 * 날짜 칸에는 현장 이름만 적습니다. 주문자·연락처·동호수는 칸에 넣지 않습니다
 * (privacy.ts 참고) — 달력은 펼쳐 놓고 보는 화면이라 더 그렇습니다.
 */
export const WorkOrderCalendarPicker: React.FC<WorkOrderCalendarPickerProps> = ({
  constructionType,
  siteType,
  selected,
  onSelect,
  onClear,
  onManualEntry,
}) => {
  const [cursor, setCursor] = useState(() => new Date());
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 팝업으로 연 날짜. null 이면 달력만 보입니다. */
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    if (!constructionType) return;
    setLoading(true);
    setError(null);
    try {
      // 날짜를 비워서 그 시공종류의 대기 건을 한 번에 받고, 달에 맞춰 나눕니다.
      // 달을 넘길 때마다 다시 부르면 신호가 약한 현장에서 넘기기가 버겁습니다.
      const { groups } = await publicApi.workOrders({ constructionType, siteType });
      setOrders(flatten(groups));
    } catch (err: any) {
      setError(err?.message || '시공건 목록을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [constructionType, siteType]);

  useEffect(() => {
    void load();
  }, [load]);

  const byDay = useMemo(() => {
    const map = new Map<string, WorkOrder[]>();
    for (const order of orders) {
      const key = order.scheduledDate || '미정';
      map.set(key, [...(map.get(key) ?? []), order]);
    }
    return map;
  }, [orders]);

  const undated = byDay.get('미정') ?? [];

  /** 지금 보고 있는 달의 시공건을 날짜순으로. 달력 아래 글자 목록에 씁니다. */
  const monthList = useMemo(() => {
    const prefix = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
    return [...byDay.entries()]
      .filter(([date]) => date.startsWith(prefix))
      .sort((left, right) => left[0].localeCompare(right[0]));
  }, [byDay, cursor]);
  const days = useMemo(() => monthGrid(cursor), [cursor]);
  const month = cursor.getMonth();
  const today = ymd(new Date());

  const dayOrders = openDay ? byDay.get(openDay) ?? [] : [];
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase().replace(/\s+/g, '');
    if (!needle) return dayOrders;
    return dayOrders.filter((order) =>
      [order.address, order.building, order.customerName, order.orderNumber]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .replace(/\s+/g, '')
        .includes(needle)
    );
  }, [dayOrders, search]);

  /* ---------------------------------------------------------------- */

  if (selected) {
    return (
      <div className="rounded-2xl border-2 border-blue-500 bg-blue-50 p-4">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-bold text-blue-700 mb-1">선택한 시공건</p>
            <p className="text-base font-extrabold text-slate-900 break-keep">
              {selected.building || maskAddress(selected.address) || '(주소 미정)'}
            </p>
            <p className="mt-1 text-xs text-slate-600">
              {selected.scheduledDate || '날짜 미정'}
              {selected.siteType ? ` · ${selected.siteType}` : ''}
              {selected.customerName ? ` · ${maskName(selected.customerName)}` : ''}
            </p>
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
    <div className="rounded-2xl border border-slate-200 bg-white p-2 sm:p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setCursor(new Date(cursor.getFullYear(), month - 1, 1))}
            aria-label="이전 달"
            className="p-2 rounded-lg border border-slate-300 text-slate-500"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="px-1 text-sm font-extrabold text-slate-900 tabular-nums whitespace-nowrap">
            {cursor.getFullYear()}.{month + 1}
          </span>
          <button
            type="button"
            onClick={() => setCursor(new Date(cursor.getFullYear(), month + 1, 1))}
            aria-label="다음 달"
            className="p-2 rounded-lg border border-slate-300 text-slate-500"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => setCursor(new Date())}
            className="ml-1 px-2 py-1.5 rounded-lg border border-slate-300 text-xs font-semibold text-slate-600 whitespace-nowrap"
          >
            오늘
          </button>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          aria-label="새로고침"
          className="p-2 rounded-lg border border-slate-300 text-slate-500 disabled:opacity-50"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 mb-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
          <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid grid-cols-7 gap-px mb-1">
        {WEEKDAYS.map((label, index) => (
          <div
            key={label}
            className={`py-1 text-center text-[11px] font-bold ${
              index === 0 ? 'text-rose-500' : index === 6 ? 'text-blue-500' : 'text-slate-400'
            }`}
          >
            {label}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-px bg-slate-200 rounded-xl overflow-hidden">
        {days.map((day) => {
          const key = ymd(day);
          const list = byDay.get(key) ?? [];
          const otherMonth = day.getMonth() !== month;
          return (
            <button
              key={key}
              type="button"
              disabled={list.length === 0}
              onClick={() => {
                setOpenDay(key);
                setSearch('');
              }}
              className={`flex flex-col items-start min-h-[58px] sm:min-h-[84px] px-0.5 pt-0.5 pb-1 text-left align-top bg-white disabled:cursor-default ${
                otherMonth ? 'opacity-40' : ''
              } ${list.length > 0 ? 'hover:bg-blue-50 active:bg-blue-100' : ''}`}
            >
              {/* 날짜는 칸의 왼쪽 위. 달력이라면 어디서나 그 자리에 있고,
                  가운데에 두면 아래 일정 표시가 들어갈 자리가 없어집니다. */}
              <span
                className={`inline-flex items-center justify-center min-w-[20px] h-5 px-1 rounded-full text-[11px] font-bold ${
                  key === today ? 'bg-blue-600 text-white' : 'text-slate-700'
                }`}
              >
                {day.getDate()}
              </span>

              {/*
               * 좁은 화면에서는 막대만 그립니다.
               *
               * 한 칸의 너비가 45px 남짓이라 현장 이름을 넣으면 "캐…" 로 잘려
               * 아무것도 알려 주지 못합니다. 구글 캘린더 모바일도 같은 이유로
               * 월 보기에서는 막대만 그리고, 글자는 날짜를 눌렀을 때 보여
               * 줍니다. 여기서도 온전한 글자는 팝업과 아래 목록에 있습니다.
               */}
              <span className="sm:hidden w-full mt-0.5 space-y-[2px]">
                {list.slice(0, 3).map((order) => (
                  <span
                    key={order.id}
                    className={`block h-[3px] rounded-full ${
                      order.status === 'SUBMITTED' ? 'bg-emerald-500' : 'bg-blue-500'
                    }`}
                  />
                ))}
                {list.length > 3 && (
                  <span className="block text-[9px] font-bold leading-none text-slate-400">
                    +{list.length - 3}
                  </span>
                )}
              </span>

              <span className="hidden sm:block w-full mt-0.5 space-y-0.5">
                {list.slice(0, 2).map((order) => (
                  <span
                    key={order.id}
                    className={`block px-1 py-0.5 rounded text-[10px] font-semibold truncate ${
                      order.status === 'SUBMITTED'
                        ? 'bg-emerald-300 text-emerald-950 ring-1 ring-inset ring-emerald-400'
                        : 'bg-blue-100 text-blue-900'
                    }`}
                  >
                    {order.building || maskAddress(order.address) || '현장'}
                  </span>
                ))}
                {list.length > 2 && (
                  <span className="block px-1 text-[10px] font-bold text-slate-500">
                    +{list.length - 2}건
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      {/*
       * 달력 아래의 목록.
       *
       * 격자 칸은 좁은 화면에서 건수밖에 담지 못하므로, 글자로 읽을 수 있는
       * 목록을 함께 둡니다. 달력에서 날짜를 짚는 방식과 목록을 훑는 방식이
       * 한 화면에 있으면 기사가 편한 쪽을 그때그때 고를 수 있습니다.
       */}
      {monthList.length > 0 && (
        <div className="mt-3 rounded-xl border border-slate-200 overflow-hidden">
          <p className="px-3 py-2 bg-slate-50 text-[11px] font-bold text-slate-500">
            {month + 1}월 시공건 {monthList.reduce((sum, [, list]) => sum + list.length, 0)}건
          </p>
          <div className="max-h-72 overflow-y-auto divide-y divide-slate-100">
            {monthList.map(([date, list]) => (
              <div key={date}>
                <p className="px-3 py-1.5 bg-white text-[11px] font-bold text-blue-700 border-b border-slate-100">
                  {Number(date.slice(5, 7))}월 {Number(date.slice(8, 10))}일 ({WEEKDAYS[new Date(date).getDay()]})
                  <span className="ml-1.5 font-semibold text-slate-400">{list.length}건</span>
                </p>
                {list.map((order) => (
                  <button
                    key={order.id}
                    type="button"
                    onClick={() => onSelect(order)}
                    className={`w-full flex items-center gap-2 px-3 py-2.5 text-left ${
                      order.status === 'SUBMITTED'
                        ? 'bg-emerald-200 hover:bg-emerald-300 active:bg-emerald-400'
                        : 'hover:bg-blue-50 active:bg-blue-100'
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-slate-900 truncate">
                        {order.building || maskAddress(order.address) || '(주소 미정)'}
                        {order.status === 'SUBMITTED' && (
                          <span className="ml-1.5 px-1.5 py-0.5 rounded bg-emerald-600 text-[10px] font-bold text-white align-middle">
                            업로드 완료
                          </span>
                        )}
                      </p>
                      <p className="text-[11px] text-slate-500 truncate">
                        {maskAddress(order.address)}
                      </p>
                    </div>
                    <ChevronRight className="w-4 h-4 text-slate-300 shrink-0" />
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {undated.length > 0 && (
        <button
          type="button"
          onClick={() => {
            setOpenDay('미정');
            setSearch('');
          }}
          className="mt-2 w-full px-3 py-2 rounded-lg border border-slate-300 text-xs font-semibold text-slate-600 text-left"
        >
          날짜 미정 {undated.length}건 — 눌러서 고르기
        </button>
      )}

      {/* 팝업 밖에도 직접 입력을 둡니다. 목록에 없는 현장을 마주친 기사가
          날짜 칸을 먼저 찾아 눌러야만 그 버튼에 닿는다면, 없는 날짜를
          헤매다 결국 업로드를 포기하게 됩니다. */}
      <button
        type="button"
        onClick={onManualEntry}
        className="mt-3 w-full flex items-center justify-center gap-2 px-4 py-3.5 rounded-xl border-2 border-amber-400 bg-amber-50 text-sm font-bold text-amber-900 hover:bg-amber-100 active:bg-amber-200"
      >
        <PencilLine className="w-4 h-4 shrink-0" />
        {/* 한 덩어리로 두면 좁은 화면에서 "직접 입" / "력하기" 처럼 낱말
            가운데가 끊깁니다. 문장 단위로 나눠 두면 그 일이 없습니다. */}
        <span className="flex flex-col items-center leading-tight">
          <span className="whitespace-nowrap">주문건 목록에 없음</span>
          <span className="whitespace-nowrap">직접 입력하기</span>
        </span>
      </button>

      {openDay && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/50 p-0 sm:p-4"
          onClick={() => setOpenDay(null)}
        >
          <div
            className="w-full sm:max-w-lg max-h-[80vh] flex flex-col bg-white rounded-t-2xl sm:rounded-2xl overflow-hidden shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-extrabold text-slate-900">
                  {openDay === '미정' ? '날짜 미정' : openDay}
                </p>
                <p className="text-[11px] text-slate-500">{dayOrders.length}건</p>
              </div>
              <button
                type="button"
                onClick={() => setOpenDay(null)}
                aria-label="닫기"
                className="p-2 rounded-lg text-slate-400"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {dayOrders.length > 4 && (
              <div className="px-4 py-2 border-b border-slate-100">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="주소 · 아파트명으로 찾기"
                    className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-300 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
            )}

            <ul className="flex-1 overflow-y-auto divide-y divide-slate-100">
              {visible.map((order, index) => (
                <li key={order.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(order);
                      setOpenDay(null);
                    }}
                    // 올라간 건도 그대로 고를 수 있습니다 — 남이 잘못 올린
                    // 경우 그 건으로 다시 올려야 합니다. 두 번째 제출은
                    // 폴더가 나뉘어 저장되므로 덮어쓰지 않습니다.
                    className={`w-full flex items-center gap-3 px-4 py-3.5 text-left ${
                      order.status === 'SUBMITTED'
                        ? 'bg-emerald-200 hover:bg-emerald-300 active:bg-emerald-400'
                        : 'hover:bg-blue-50 active:bg-blue-100'
                    }`}
                  >
                    {/* 팝업 안에서는 자르지 않습니다 — 주소가 잘리면 같은
                        아파트의 다른 동을 구분할 수 없고, 그것이 이 팝업을
                        여는 유일한 이유입니다. */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-slate-900 break-keep">
                        <span className="mr-1.5 text-slate-400">{index + 1}.</span>
                        {order.building || maskAddress(order.address) || '(주소 미정)'}
                        {order.status === 'SUBMITTED' && (
                          <span className="ml-1.5 px-1.5 py-0.5 rounded bg-emerald-600 text-[10px] font-bold text-white align-middle">
                            업로드 완료
                          </span>
                        )}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500 break-keep">
                        <MapPin className="inline w-3 h-3 mr-0.5 -mt-0.5" />
                        {maskAddress(order.address)}
                        {order.customerName ? ` · ${maskName(order.customerName)}` : ''}
                      </p>
                    </div>
                    <ChevronRight className="w-4 h-4 text-slate-300 shrink-0" />
                  </button>
                </li>
              ))}
              {visible.length === 0 && (
                <li className="px-4 py-6 text-center text-xs text-slate-400">
                  {search ? '검색 결과가 없습니다.' : '이 날짜에는 시공건이 없습니다.'}
                </li>
              )}
            </ul>

            <div className="p-3 border-t border-slate-200">
              <button
                type="button"
                onClick={() => {
                  setOpenDay(null);
                  onManualEntry();
                }}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl border-2 border-amber-400 bg-amber-50 text-sm font-bold text-amber-900"
              >
                <PencilLine className="w-4 h-4 shrink-0" />
                <span className="flex flex-col items-center leading-tight">
                  <span className="whitespace-nowrap">원하는 주문이 없음</span>
                  <span className="whitespace-nowrap">직접 입력하기</span>
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

function flatten(groups: WorkOrderGroup[]): WorkOrder[] {
  return groups.flatMap((group) => group.regions.flatMap((entry) => entry.orders));
}
