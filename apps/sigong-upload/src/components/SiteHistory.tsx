import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ClipboardList,
  Filter,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  Video,
  X,
  XCircle,
} from 'lucide-react';
import { adminApi } from '../api';
import { statusMeta } from '../status';
import { titleStyle } from '../technicians';
import { typeStyle } from '../constructionTypes';
import { DateRangeInput } from './DateRangeInput';
import { ROLE_LABELS } from '../types';
import type { AdminSession, SiteRecord, Technician } from '../types';

interface SiteHistoryProps {
  session: AdminSession;
  onOpenSite: (siteId: string) => void;
}

interface Filters {
  constructionType: string;
  technicianId: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: Filters = { constructionType: '', technicianId: '', from: '', to: '' };

/** "8/20" — compact enough for a phone row, unambiguous next to a label. */
function shortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/**
 * 시공현황 리스트.
 *
 * The same screen for all three roles — what differs is the scope, and that is
 * decided by the server from the signed-in account. The client only asks; it
 * never says which company's data it wants.
 *
 * Rows are held to two lines because this is read on a phone: address on the
 * first line, everything else compressed onto the second.
 */
export const SiteHistory: React.FC<SiteHistoryProps> = ({ session, onOpenSite }) => {
  const [sites, setSites] = useState<SiteRecord[]>([]);
  const [constructionTypes, setConstructionTypes] = useState<string[]>([]);
  const [technicians, setTechnicians] = useState<Technician[]>([]);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [isLoading, setIsLoading] = useState(false);
  const [needsScope, setNeedsScope] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    adminApi
      .historyFilters()
      .then(({ constructionTypes: types, technicians: list }) => {
        setConstructionTypes(types);
        setTechnicians(list);
      })
      .catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const page = await adminApi.history({
        constructionType: filters.constructionType || undefined,
        technicianId: filters.technicianId || undefined,
        from: filters.from || undefined,
        to: filters.to || undefined,
        limit: 200,
      });
      setSites(page.items);
      setNeedsScope(Boolean(page.needsScope));
    } catch (err: any) {
      setError(err?.message || '시공현황을 불러오지 못했습니다.');
    } finally {
      setIsLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);

  const activeFilterCount = useMemo(() => {
    // A from/to pair is one filter to the reader, not two.
    const { from, to, ...rest } = filters;
    return Object.values(rest).filter(Boolean).length + (from || to ? 1 : 0);
  }, [filters]);

  const totals = useMemo(
    () => ({
      sites: sites.length,
      photos: sites.reduce(
        (sum, site) => sum + site.files.filter((f) => f.fileType === 'image').length,
        0
      ),
      videos: sites.reduce(
        (sum, site) => sum + site.files.filter((f) => f.fileType === 'video').length,
        0
      ),
    }),
    [sites]
  );

  // A technician's own filter list would only ever hold themselves.
  const showTechnicianFilter = session.role !== 'TECH' && technicians.length > 0;
  const showTypeFilter = constructionTypes.length > 1;

  return (
    <div className="max-w-5xl mx-auto py-5 sm:py-8 px-3 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h2 className="text-lg sm:text-2xl font-extrabold text-slate-900 flex items-center gap-2">
            <ClipboardList className="w-5 h-5 sm:w-6 sm:h-6 text-blue-600 shrink-0" />
            시공현황 리스트
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            {session.role === 'TECH'
              ? `${session.displayName} 님이 참여한 시공 자료입니다.`
              : session.role === 'MASTER'
                ? '전체 업체의 시공 자료입니다.'
                : `담당 시공종류: ${session.constructionTypes.join(', ') || '미지정'}`}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setShowFilters((prev) => !prev)}
            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-semibold transition-colors ${
              activeFilterCount > 0
                ? 'bg-blue-50 border-blue-300 text-blue-800'
                : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'
            }`}
          >
            <Filter className="w-3.5 h-3.5" />
            <span>필터</span>
            {activeFilterCount > 0 && (
              <span className="px-1.5 rounded-full bg-blue-600 text-white text-[10px] font-bold">
                {activeFilterCount}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-blue-600' : ''}`} />
            <span className="hidden sm:inline">새로고침</span>
          </button>
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-2 mb-3">
        <SummaryTile label="현장" value={`${totals.sites}건`} />
        <SummaryTile label="사진" value={`${totals.photos}장`} />
        <SummaryTile label="동영상" value={`${totals.videos}개`} />
      </div>

      {/* Filters — available to every role. */}
      {showFilters && (
        <div className="bg-white rounded-xl border border-slate-200 p-4 mb-3 space-y-3.5">
          <div>
            <span className="block text-xs font-bold text-slate-700 mb-1.5">시공일 기간</span>
            <DateRangeInput
              presets
              from={filters.from}
              to={filters.to}
              onChange={({ from, to }) => setFilters({ ...filters, from, to })}
            />
          </div>

          {showTypeFilter && (
            <div>
              <span className="block text-xs font-bold text-slate-700 mb-1.5">시공종류</span>
              <div className="flex flex-wrap gap-1.5">
                <FilterChip
                  active={!filters.constructionType}
                  onClick={() => setFilters({ ...filters, constructionType: '' })}
                >
                  전체
                </FilterChip>
                {constructionTypes.map((type) => {
                  const style = typeStyle(type);
                  const active = filters.constructionType === type;
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() =>
                        setFilters({ ...filters, constructionType: active ? '' : type })
                      }
                      className={`px-2.5 py-1.5 rounded-lg border-2 text-xs font-bold transition-colors ${
                        active ? style.selected : 'border-slate-200 bg-white text-slate-600'
                      }`}
                    >
                      {type}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {showTechnicianFilter && (
            <label className="block">
              <span className="block text-xs font-bold text-slate-700 mb-1.5">시공기사</span>
              <select
                value={filters.technicianId}
                onChange={(e) => setFilters({ ...filters, technicianId: e.target.value })}
                className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm bg-white"
              >
                <option value="">전체</option>
                {technicians.map((tech) => (
                  <option key={tech.id} value={tech.id}>
                    {tech.name} ({tech.title})
                  </option>
                ))}
              </select>
            </label>
          )}

          {activeFilterCount > 0 && (
            <button
              type="button"
              onClick={() => setFilters(EMPTY_FILTERS)}
              className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-800"
            >
              <X className="w-3.5 h-3.5" />
              필터 초기화
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800 mb-3">
          <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span className="flex-1">{error}</span>
        </div>
      )}

      {needsScope && (
        <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900 mb-3">
          이 계정에 담당 시공종류가 아직 지정되지 않았습니다. 마스터관리자에게 계정 설정을 요청해
          주세요.
        </div>
      )}

      {/* List */}
      {isLoading && sites.length === 0 ? (
        <p className="py-16 text-center text-xs text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2 text-blue-500" />
          불러오는 중...
        </p>
      ) : sites.length === 0 ? (
        <div className="py-16 text-center">
          <ClipboardList className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <p className="text-sm font-semibold text-slate-600">조회된 시공 자료가 없습니다.</p>
          <p className="text-xs text-slate-400 mt-1">
            {activeFilterCount > 0 ? '필터를 넓혀 보세요.' : '제출된 자료가 여기에 표시됩니다.'}
          </p>
        </div>
      ) : (
        <ul className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100 overflow-hidden">
          {sites.map((site) => {
            const meta = statusMeta(site.status);
            const style = typeStyle(site.constructionType);
            const photos = site.files.filter((f) => f.fileType === 'image').length;
            const videos = site.files.filter((f) => f.fileType === 'video').length;

            return (
              <li key={site.id}>
                <button
                  type="button"
                  onClick={() => onOpenSite(site.id)}
                  className="w-full text-left px-3 py-2.5 hover:bg-slate-50 transition-colors flex items-center gap-2.5"
                >
                  <span className={`w-1.5 h-10 rounded-full shrink-0 ${style.accent}`} />

                  <span className="flex-1 min-w-0">
                    {/* Line 1 — what and where */}
                    <span className="flex items-center gap-1.5 min-w-0">
                      <span
                        className={`px-1.5 py-0.5 rounded border text-[11px] font-bold shrink-0 ${style.chip}`}
                      >
                        {site.constructionType}
                      </span>
                      <span className="text-sm font-bold text-slate-900 truncate">
                        {site.address}
                      </span>
                    </span>

                    {/* Line 2 — when, who, how much */}
                    <span className="flex items-center gap-2 mt-0.5 text-[11px] text-slate-500 min-w-0">
                      <span className="font-semibold text-slate-700 shrink-0">
                        시공 {shortDate(site.constructionDate)}
                      </span>
                      <span className="text-slate-300 shrink-0">|</span>
                      <span className="shrink-0">제출 {shortDate(site.createdAt)}</span>
                      <span className="text-slate-300 shrink-0">|</span>
                      <span className="truncate">
                        {(site.technicians || []).length > 0
                          ? site.technicians.map((t) => t.name).join(', ')
                          : site.managerName}
                      </span>
                      <span className="ml-auto inline-flex items-center gap-1.5 shrink-0">
                        {photos > 0 && (
                          <span className="inline-flex items-center gap-0.5">
                            <ImageIcon className="w-3 h-3" />
                            {photos}
                          </span>
                        )}
                        {videos > 0 && (
                          <span className="inline-flex items-center gap-0.5">
                            <Video className="w-3 h-3" />
                            {videos}
                          </span>
                        )}
                      </span>
                    </span>
                  </span>

                  <span
                    className={`px-1.5 py-0.5 rounded border text-[10px] font-bold shrink-0 ${meta.className}`}
                  >
                    {meta.short}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* The roster colours are only meaningful if the legend is somewhere. */}
      {sites.length > 0 && session.role !== 'TECH' && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
          <span className="font-semibold">직함:</span>
          {(['팀장', '사수', '부사수'] as const).map((title) => (
            <span
              key={title}
              className={`px-1.5 py-0.5 rounded border font-bold ${titleStyle(title).chip}`}
            >
              {title}
            </span>
          ))}
        </div>
      )}

      <p className="mt-4 text-center text-[11px] text-slate-400">
        {ROLE_LABELS[session.role]} 권한으로 조회 가능한 자료만 표시됩니다.
      </p>
    </div>
  );
};

const SummaryTile: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="bg-white rounded-lg border border-slate-200 px-3 py-2 text-center">
    <p className="text-[11px] text-slate-500 font-medium">{label}</p>
    <p className="text-sm sm:text-base font-extrabold text-slate-900">{value}</p>
  </div>
);

const FilterChip: React.FC<{
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ active, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    className={`px-2.5 py-1.5 rounded-lg border-2 text-xs font-bold transition-colors ${
      active ? 'border-slate-800 bg-slate-800 text-white' : 'border-slate-200 bg-white text-slate-600'
    }`}
  >
    {children}
  </button>
);
