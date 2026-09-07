import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Loader2,
  MapPin,
  Phone,
  RefreshCw,
  User,
  X,
} from 'lucide-react';
import { adminApi } from '../api';
import { WorkOrderTable } from './WorkOrderTable';
import { isMaster, normalizeRegionGroup, REGION_GROUPS } from '../types';
import type { AdminSession, WorkOrder } from '../types';

interface AdminCalendarProps {
  session: AdminSession;
  constructionTypes: string[];
}

type ViewMode = 'month' | 'week' | 'day';

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/**
 * 시공종류별 색.
 *
 * 구글 캘린더가 달력마다 색을 주는 것과 같은 이유입니다 — 격자에서는 글자를
 * 읽기 전에 색으로 종류가 구분되어야 합니다. 이름의 해시로 고르므로 시공종류가
 * 추가돼도 손댈 곳이 없고, 같은 이름은 늘 같은 색을 받습니다.
 */
const PALETTE = [
  { chip: 'bg-blue-100 text-blue-900 border-blue-200', dot: 'bg-blue-500' },
  { chip: 'bg-emerald-100 text-emerald-900 border-emerald-200', dot: 'bg-emerald-500' },
  { chip: 'bg-amber-100 text-amber-900 border-amber-200', dot: 'bg-amber-500' },
  { chip: 'bg-violet-100 text-violet-900 border-violet-200', dot: 'bg-violet-500' },
  { chip: 'bg-rose-100 text-rose-900 border-rose-200', dot: 'bg-rose-500' },
  { chip: 'bg-cyan-100 text-cyan-900 border-cyan-200', dot: 'bg-cyan-500' },
];

function colorOf(name: string) {
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length]!;
}

const iso = (date: Date) => date.toISOString().slice(0, 10);
const todayIso = () => iso(new Date());

function addDays(value: string, delta: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return iso(date);
}

function addMonths(value: string, delta: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + delta);
  return iso(date);
}

/** 그 주의 일요일. 구글 캘린더와 같은 주 시작 기준입니다. */
function startOfWeek(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  return addDays(value, -date.getUTCDay());
}

function formatRange(anchor: string, view: ViewMode): string {
  const date = new Date(`${anchor}T00:00:00Z`);
  if (view === 'month') return `${date.getUTCFullYear()}년 ${date.getUTCMonth() + 1}월`;
  if (view === 'day') {
    return `${date.getUTCMonth() + 1}월 ${date.getUTCDate()}일 (${WEEKDAYS[date.getUTCDay()]})`;
  }
  const start = startOfWeek(anchor);
  const end = addDays(start, 6);
  return `${start.slice(5).replace('-', '.')} – ${end.slice(5).replace('-', '.')}`;
}

/**
 * 시공 일정 캘린더.
 *
 * 목록은 "무엇이 있는가"에 답하고 캘린더는 "언제 몰려 있는가"에 답합니다.
 * 배차와 인원 배치는 후자를 보고 정하는 일이라, 같은 데이터라도 격자에 얹는
 * 것만으로 목록이 못 하던 일을 합니다.
 *
 * 구글 캘린더의 관습을 그대로 따릅니다 — 월/주/일 보기, 오늘 버튼, 좌우 이동,
 * 날짜 칸의 일정 칩, 그리고 칸을 더블클릭하면 그 날의 상세가 열립니다.
 * 새로 배울 것이 없다는 점 자체가 기능입니다.
 */
export const AdminCalendar: React.FC<AdminCalendarProps> = ({ session, constructionTypes }) => {
  const allowedTypes = useMemo(
    () => (isMaster(session.role) ? constructionTypes : session.constructionTypes),
    [session, constructionTypes]
  );

  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [view, setView] = useState<ViewMode>('month');
  const [anchor, setAnchor] = useState(todayIso());
  /** 더블클릭으로 열리는 그 날의 상세. */
  const [openDay, setOpenDay] = useState<string | null>(null);

  const [filterTypes, setFilterTypes] = useState<string[]>([]);
  const [filterSiteType, setFilterSiteType] = useState('');
  const [filterTechnician, setFilterTechnician] = useState('');
  const [filterRegion, setFilterRegion] = useState('');
  const [includeDone, setIncludeDone] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // 목록에서 취소·제출완료도 다뤄야 하므로 전체를 받아 옵니다. 캘린더의
      // 표시 여부는 아래 includeDone 으로 화면에서 거릅니다.
      const page = await adminApi.workOrders({ limit: 500 });
      setOrders(page.items);
    } catch (err: any) {
      setError(err?.message || '일정을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [includeDone]);

  useEffect(() => {
    void load();
  }, [load]);

  const technicianOptions = useMemo(
    () =>
      [...new Set(orders.map((order) => order.technicianName).filter(Boolean))].sort((a, b) =>
        String(a).localeCompare(String(b), 'ko')
      ) as string[],
    [orders]
  );

  /** 필터는 서로 중첩됩니다 — 시공종류 ∩ 기사 ∩ 권역. */
  const visible = useMemo(
    () =>
      orders.filter((order) => {
        if (filterTypes.length > 0 && !filterTypes.includes(order.constructionType)) return false;
        if (filterSiteType && (order.siteType || '') !== filterSiteType) return false;
        if (filterTechnician && !(order.technicianName || '').includes(filterTechnician)) return false;
        if (filterRegion && (normalizeRegionGroup(order.regionGroup)) !== filterRegion) return false;
        // 캘린더 격자에는 기본적으로 대기 중인 건만 올립니다.
        if (!includeDone && order.status !== 'OPEN') return false;
        return true;
      }),
    [orders, filterTypes, filterSiteType, filterTechnician, filterRegion, includeDone]
  );

  /**
   * 고를 수 있는 현장종류. 지금 고른 시공종류의 주문에서 뽑습니다.
   *
   * 설정에 저장된 선택값이 아니라 실제 주문에서 뽑는 이유: 주문은 매 동기화마다
   * 시트와 맞춰지므로, 시트에서 탭을 지우면 그 현장종류도 여기서 저절로
   * 사라집니다. 별도 목록을 참조하면 지운 탭이 필터에 남습니다.
   */
  const siteTypeOptions = useMemo(
    () =>
      [
        ...new Set(
          orders
            .filter(
              (order) =>
                filterTypes.length === 0 || filterTypes.includes(order.constructionType)
            )
            .map((order) => order.siteType)
            .filter(Boolean)
        ),
      ].sort((left, right) => String(left).localeCompare(String(right), 'ko')) as string[],
    [orders, filterTypes]
  );

  // 고른 현장종류가 목록에서 사라지면(시트에서 탭 삭제) 필터를 풉니다 —
  // 아무것도 안 나오는 화면을 두고 원인을 찾게 만들지 않습니다.
  useEffect(() => {
    if (filterSiteType && !siteTypeOptions.includes(filterSiteType)) setFilterSiteType('');
  }, [siteTypeOptions, filterSiteType]);

  const byDate = useMemo(() => {
    const map = new Map<string, WorkOrder[]>();
    for (const order of visible) {
      if (!order.scheduledDate) continue;
      const list = map.get(order.scheduledDate) ?? [];
      list.push(order);
      map.set(order.scheduledDate, list);
    }
    return map;
  }, [visible]);

  const undated = useMemo(() => visible.filter((order) => !order.scheduledDate), [visible]);

  /** 보이는 범위의 날짜들. 월 보기는 앞뒤 달을 채워 6주 격자를 만듭니다. */
  const days = useMemo(() => {
    if (view === 'day') return [anchor];
    if (view === 'week') {
      const start = startOfWeek(anchor);
      return Array.from({ length: 7 }, (_, index) => addDays(start, index));
    }
    const firstOfMonth = `${anchor.slice(0, 7)}-01`;
    const start = startOfWeek(firstOfMonth);
    const cells = Array.from({ length: 42 }, (_, index) => addDays(start, index));
    // 마지막 주가 통째로 다음 달이면 지웁니다 — 빈 줄은 격자를 흐리게 할 뿐입니다.
    while (cells.length > 35 && !cells.slice(-7).some((day) => day.slice(0, 7) === anchor.slice(0, 7))) {
      cells.splice(-7);
    }
    return cells;
  }, [anchor, view]);

  const move = (delta: number) => {
    if (view === 'month') setAnchor(addMonths(anchor, delta));
    else setAnchor(addDays(anchor, view === 'week' ? delta * 7 : delta));
  };

  const toggleType = (type: string) =>
    setFilterTypes((current) =>
      current.includes(type) ? current.filter((entry) => entry !== type) : [...current, type]
    );

  const dayOrders = openDay ? (byDate.get(openDay) ?? []) : [];

  /* ---------------------------------------------------------------- */

  return (
    <div className="max-w-6xl mx-auto py-5 sm:py-8 px-3 sm:px-6">
      <div className="mb-4">
        <h2 className="text-lg sm:text-2xl font-extrabold text-slate-900 flex items-center gap-2">
          <CalendarDays className="w-5 h-5 sm:w-6 sm:h-6 text-blue-600 shrink-0" />
          시공 캘린더
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          날짜 칸을 <strong>더블클릭</strong>하면 그 날의 주문건이 열립니다.
        </p>
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800 mb-4">
          <X className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* 상단 바 — 구글 캘린더와 같은 배치: 오늘 · 좌우 · 범위 · 보기 전환 */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button
          type="button"
          onClick={() => setAnchor(todayIso())}
          className="px-3 py-2 rounded-lg border border-slate-300 bg-white text-xs font-bold text-slate-700 hover:bg-slate-50"
        >
          오늘
        </button>
        <div className="flex items-center">
          <button
            type="button"
            onClick={() => move(-1)}
            className="p-2 rounded-l-lg border border-slate-300 bg-white text-slate-500 hover:bg-slate-50"
            aria-label="이전"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => move(1)}
            className="p-2 rounded-r-lg border border-l-0 border-slate-300 bg-white text-slate-500 hover:bg-slate-50"
            aria-label="다음"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
        <p className="text-sm font-extrabold text-slate-900">{formatRange(anchor, view)}</p>

        <div className="ml-auto flex items-center gap-1">
          {([['month', '월'], ['week', '주'], ['day', '일']] as const).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              onClick={() => setView(mode)}
              className={`px-3 py-2 rounded-lg border text-xs font-bold ${
                view === mode
                  ? 'border-blue-500 bg-blue-600 text-white'
                  : 'border-slate-300 bg-white text-slate-600'
              }`}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="p-2 rounded-lg border border-slate-300 bg-white text-slate-500 disabled:opacity-50"
            aria-label="새로고침"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* 필터 — 구글 캘린더 왼쪽의 "내 캘린더" 체크박스에 해당합니다. */}
      <div className="rounded-xl border border-slate-200 bg-white p-3 mb-3">
        <div className="flex flex-wrap items-center gap-1.5 mb-2">
          {allowedTypes.map((type) => {
            const on = filterTypes.length === 0 || filterTypes.includes(type);
            const color = colorOf(type);
            return (
              <button
                key={type}
                type="button"
                onClick={() => toggleType(type)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-bold ${
                  on ? color.chip : 'border-slate-200 bg-white text-slate-300'
                }`}
              >
                <span className={`w-2 h-2 rounded-full ${on ? color.dot : 'bg-slate-300'}`} />
                {type}
              </button>
            );
          })}
          {filterTypes.length > 0 && (
            <button
              type="button"
              onClick={() => setFilterTypes([])}
              className="px-2 py-1.5 text-[11px] font-semibold text-slate-500 underline"
            >
              전체 보기
            </button>
          )}
        </div>

        {/* 현장종류 — 시공종류 아래 한 단계. 선택값은 구글시트 탭 이름에서
            오므로, 등록된 주문에서 뽑으면 시트를 고칠 때마다 따라 바뀝니다.
            따로 관리하는 목록을 두면 시트에서 지운 탭이 여기 남습니다. */}
        {siteTypeOptions.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 mb-2">
            <span className="text-[11px] font-bold text-slate-400">현장종류</span>
            {siteTypeOptions.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => setFilterSiteType(filterSiteType === name ? '' : name)}
                className={`px-2.5 py-1.5 rounded-lg border text-xs font-bold ${
                  filterSiteType === name
                    ? 'border-emerald-600 bg-emerald-600 text-white'
                    : 'border-slate-300 text-slate-600'
                }`}
              >
                {name}
              </button>
            ))}
            {filterSiteType && (
              <button
                type="button"
                onClick={() => setFilterSiteType('')}
                className="px-2 py-1.5 text-[11px] font-semibold text-slate-500 underline"
              >
                전체 보기
              </button>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={filterTechnician}
            onChange={(event) => setFilterTechnician(event.target.value)}
            className="px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs"
          >
            <option value="">전체 기사</option>
            {technicianOptions.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
          <select
            value={filterRegion}
            onChange={(event) => setFilterRegion(event.target.value)}
            className="px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs"
          >
            <option value="">전체 권역</option>
            {REGION_GROUPS.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
          <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600">
            <input
              type="checkbox"
              checked={includeDone}
              onChange={(event) => setIncludeDone(event.target.checked)}
            />
            제출 완료 건도 표시
          </label>
          <span className="ml-auto text-[11px] text-slate-500">
            {visible.length}건
            {undated.length > 0 && ` · 날짜 미정 ${undated.length}건`}
          </span>
        </div>
      </div>

      {/* 격자 */}
      <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
        {view !== 'day' && (
          <div className="grid grid-cols-7 border-b border-slate-200">
            {WEEKDAYS.map((label, index) => (
              <div
                key={label}
                className={`py-2 text-center text-[11px] font-bold ${
                  index === 0 ? 'text-rose-500' : index === 6 ? 'text-blue-500' : 'text-slate-400'
                }`}
              >
                {label}
              </div>
            ))}
          </div>
        )}

        <div className={view === 'day' ? '' : 'grid grid-cols-7'}>
          {days.map((day) => {
            const list = byDate.get(day) ?? [];
            const inRange = view !== 'month' || day.slice(0, 7) === anchor.slice(0, 7);
            const isToday = day === todayIso();
            const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();

            return (
              <button
                key={day}
                type="button"
                onDoubleClick={() => setOpenDay(day)}
                onClick={() => {
                  if (view === 'month') setAnchor(day);
                }}
                className={`text-left border-b border-r border-slate-100 p-1.5 align-top ${
                  view === 'day' ? 'min-h-[300px] w-full' : view === 'week' ? 'min-h-[180px]' : 'min-h-[104px]'
                } ${inRange ? 'bg-white' : 'bg-slate-50/60'} hover:bg-blue-50/50`}
              >
                <div className="flex items-center gap-1 mb-1">
                  <span
                    className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${
                      isToday
                        ? 'bg-blue-600 text-white'
                        : !inRange
                          ? 'text-slate-300'
                          : weekday === 0
                            ? 'text-rose-500'
                            : weekday === 6
                              ? 'text-blue-500'
                              : 'text-slate-700'
                    }`}
                  >
                    {Number(day.slice(8))}
                  </span>
                  {list.length > 0 && (
                    <span className="text-[10px] font-bold text-slate-400">{list.length}건</span>
                  )}
                </div>

                <div className="space-y-0.5">
                  {list.slice(0, view === 'month' ? 3 : 8).map((order) => {
                    const color = colorOf(order.constructionType);
                    return (
                      <div
                        key={order.id}
                        className={`flex items-center gap-1 truncate rounded px-1.5 py-0.5 border text-[10px] font-semibold ${color.chip}`}
                        title={`${order.constructionType} · ${order.technicianName || '담당 미정'} · ${normalizeRegionGroup(order.regionGroup)}\n${order.address}`}
                      >
                        {/* 시공종류 · 기사 · 지역 — 격자 한 줄에 들어가는 최소한.
                            자세한 것은 칸을 더블클릭하면 나옵니다. */}
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${color.dot}`} />
                        <span className="shrink-0">{order.constructionType}</span>
                        <span className="opacity-50 shrink-0">·</span>
                        <span className="truncate">{order.technicianName || '담당 미정'}</span>
                        <span className="opacity-50 shrink-0">·</span>
                        <span className="shrink-0 opacity-80">{normalizeRegionGroup(order.regionGroup)}</span>
                      </div>
                    );
                  })}
                  {list.length > (view === 'month' ? 3 : 8) && (
                    <p className="px-1 text-[10px] font-bold text-slate-400">
                      +{list.length - (view === 'month' ? 3 : 8)}건 더
                    </p>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 같은 데이터를 목록으로도 봅니다. 캘린더는 "언제 몰려 있는가"에,
          목록은 "무엇이 있는가"에 답합니다. 한 탭에 두어야 하나를 보다가
          다른 하나가 필요해질 때 화면을 옮기지 않아도 됩니다. */}
      <div className="mt-4">
        <WorkOrderTable
          orders={orders}
          allowedTypes={allowedTypes}
          onRefresh={() => void load()}
          onFeedback={(kind, text) =>
            kind === 'error' ? setError(text) : setError(null)
          }
        />
      </div>

      {undated.length > 0 && (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3">
          <p className="text-xs font-bold text-amber-900 mb-1">
            날짜 미정 {undated.length}건
          </p>
          <p className="text-[11px] text-amber-800">
            주문서에 시공예정일이 비어 있던 건입니다. 캘린더에는 놓을 자리가 없으니
            [주문서 · 시공현장] 화면에서 날짜를 채워 주세요.
          </p>
        </div>
      )}

      {/* 더블클릭으로 열리는 그 날의 상세 */}
      {openDay && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/40 p-0 sm:p-6"
          onClick={() => setOpenDay(null)}
        >
          <div
            className="w-full sm:max-w-2xl max-h-[85vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl bg-white p-4 sm:p-6"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 mb-3">
              <div>
                <h3 className="text-base font-extrabold text-slate-900">
                  {openDay.replace(/-/g, '. ')} ({WEEKDAYS[new Date(`${openDay}T00:00:00Z`).getUTCDay()]})
                </h3>
                <p className="text-xs text-slate-500">{dayOrders.length}건</p>
              </div>
              <button
                type="button"
                onClick={() => setOpenDay(null)}
                className="p-2 rounded-lg border border-slate-300 text-slate-500"
                aria-label="닫기"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {dayOrders.length === 0 ? (
              <p className="p-4 rounded-lg bg-slate-50 text-xs text-slate-500">
                이 날짜에 등록된 주문건이 없습니다.
              </p>
            ) : (
              <ul className="space-y-2">
                {dayOrders.map((order) => {
                  const color = colorOf(order.constructionType);
                  return (
                    <li key={order.id} className="rounded-xl border border-slate-200 p-3">
                      <div className="flex flex-wrap items-center gap-2 mb-1.5">
                        <span className={`px-2 py-0.5 rounded-md border text-[11px] font-bold ${color.chip}`}>
                          {order.constructionType}
                        </span>
                        {order.siteType && (
                          <span className="text-[11px] font-semibold text-slate-500">{order.siteType}</span>
                        )}
                        <span className="ml-auto px-1.5 py-0.5 rounded bg-slate-100 text-[10px] font-bold text-slate-500">
                          {normalizeRegionGroup(order.regionGroup)}
                        </span>
                      </div>
                      <p className="text-sm font-bold text-slate-900">
                        {order.building || order.address || '(주소 미정)'}
                      </p>
                      <dl className="mt-1 space-y-0.5 text-[11px] text-slate-600">
                        {order.building && order.address && (
                          <div className="flex gap-1.5">
                            <MapPin className="w-3 h-3 shrink-0 mt-0.5 text-slate-400" />
                            <span className="break-all">{order.address}</span>
                          </div>
                        )}
                        {order.customerName && (
                          <div className="flex gap-1.5">
                            <User className="w-3 h-3 shrink-0 mt-0.5 text-slate-400" />
                            <span>
                              {order.customerName}
                              {order.technicianName && ` · 담당 ${order.technicianName}`}
                            </span>
                          </div>
                        )}
                        {order.phone && (
                          <div className="flex gap-1.5">
                            <Phone className="w-3 h-3 shrink-0 mt-0.5 text-slate-400" />
                            <a href={`tel:${order.phone}`} className="underline">{order.phone}</a>
                          </div>
                        )}
                      </dl>
                      {order.notes && (
                        <p className="mt-1.5 rounded-lg bg-slate-50 px-2 py-1.5 text-[11px] text-slate-600">
                          {order.notes}
                        </p>
                      )}
                      {order.status === 'SUBMITTED' && (
                        <p className="mt-1.5 text-[11px] font-bold text-emerald-700">자료 제출 완료</p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
