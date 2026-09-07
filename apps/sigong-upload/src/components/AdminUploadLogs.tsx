import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { EMPTY_FILTERS, RecordFilterBar, matchesFilters } from './RecordFilterBar';
import type { RecordFilters } from './RecordFilterBar';
import { regionGroupOf } from '../types';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Clock,
  HardDrive,
  Loader2,
  RefreshCw,
  ScrollText,
  XCircle,
} from 'lucide-react';
import { adminApi } from '../api';
import type { UploadLog, UploadResult } from '../types';

interface LogSummary {
  days: number;
  total: number;
  success: number;
  partial: number;
  failed: number;
  totalBytes: number;
  fileCount: number;
}

const RESULT_STYLE: Record<UploadResult, { label: string; className: string; Icon: typeof CheckCircle2 }> = {
  SUCCESS: {
    label: '성공',
    className: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    Icon: CheckCircle2,
  },
  PARTIAL: {
    label: '일부 실패',
    className: 'bg-amber-100 text-amber-800 border-amber-200',
    Icon: AlertCircle,
  },
  FAILED: { label: '실패', className: 'bg-red-100 text-red-800 border-red-200', Icon: XCircle },
};

const FILTERS: Array<{ value: UploadResult | ''; label: string }> = [
  { value: '', label: '전체' },
  { value: 'SUCCESS', label: '성공' },
  { value: 'PARTIAL', label: '일부 실패' },
  { value: 'FAILED', label: '실패' },
];

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}초`;
}

interface AdminUploadLogsProps {
  onOpenSite: (siteId: string) => void;
}

/** Chronological audit trail of every submission attempt. */
export const AdminUploadLogs: React.FC<AdminUploadLogsProps> = ({ onOpenSite }) => {
  const [logs, setLogs] = useState<UploadLog[]>([]);
  const [summary, setSummary] = useState<LogSummary | null>(null);
  const [filter, setFilter] = useState<UploadResult | ''>('');
  const [filters, setFilters] = useState<RecordFilters>(EMPTY_FILTERS);
  const [cursor, setCursor] = useState<string | undefined>();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (nextFilter: UploadResult | '', append = false, nextCursor?: string) => {
      setIsLoading(true);
      setError(null);
      try {
        const page = await adminApi.logs({
          result: nextFilter || undefined,
          cursor: nextCursor,
          limit: 50,
        });
        setLogs((prev) => (append ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
      } catch (err: any) {
        setError(err?.message || '업로드 로그를 불러오지 못했습니다.');
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  const loadSummary = useCallback(async () => {
    try {
      setSummary(await adminApi.logSummary(30));
    } catch {
      setSummary(null);
    }
  }, []);

  useEffect(() => {
    void load(filter);
  }, [filter, load]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const typeOptions = useMemo(
    () => [...new Set(logs.map((log) => log.constructionType).filter(Boolean))].sort(),
    [logs]
  );
  /** managerName 은 "홍길동(팀장), 김철수(사수)" 형태라 이름만 떼어 냅니다. */
  const technicianOptions = useMemo(
    () =>
      [...new Set(
        logs.flatMap((log) =>
          (log.managerName || '').split(',').map((part) => part.replace(/\(.*?\)/g, '').trim())
        )
      )]
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b, 'ko')),
    [logs]
  );

  /** 결과 필터(성공/실패)와 중첩됩니다. */
  const visibleLogs = useMemo(
    () =>
      logs.filter((log) =>
        matchesFilters(filters, {
          // 로그는 "언제 올렸는가"가 기준입니다.
          date: (log.at || '').slice(0, 10),
          constructionType: log.constructionType,
          technicians: log.managerName || '',
          regionGroup: regionGroupOf(log.address || ''),
        })
      ),
    [logs, filters]
  );

  /** 조건이 하나라도 걸렸는지. 걸렸으면 집계도 그 결과를 따라갑니다. */
  const narrowed = visibleLogs.length !== logs.length || Boolean(filter);

  const counts = useMemo(
    () =>
      visibleLogs.reduce(
        (sum, log) => ({
          success: sum.success + (log.result === 'SUCCESS' ? 1 : 0),
          partial: sum.partial + (log.result === 'PARTIAL' ? 1 : 0),
          failed: sum.failed + (log.result === 'FAILED' ? 1 : 0),
          fileCount: sum.fileCount + (log.fileCount || 0),
          totalBytes: sum.totalBytes + (log.totalBytes || 0),
        }),
        { success: 0, partial: 0, failed: 0, fileCount: 0, totalBytes: 0 }
      ),
    [visibleLogs]
  );

  /** 지금 보이는 로그를 그대로 엑셀로. 조건은 파일 안에 한 줄로 남깁니다. */
  const exportExcel = () => {
    const parts = [
      filters.from && (filters.from === filters.to ? filters.from : `${filters.from}~${filters.to}`),
      filters.constructionType,
      filters.technician,
      filters.regionGroup,
      filter && { SUCCESS: '성공만', PARTIAL: '일부 실패만', FAILED: '실패만' }[filter],
    ].filter(Boolean);
    void adminApi.exportRows(
      'logs',
      visibleLogs,
      `업로드 로그 ${visibleLogs.length}건${parts.length ? ` · ${parts.join(' · ')}` : ' · 전체'}`
    );
  };

  /** Refresh reloads the rollup as well as the list — they must agree. */
  const refresh = () => {
    void load(filter);
    void loadSummary();
  };

  return (
    <div className="max-w-7xl mx-auto py-6 sm:py-8 px-4 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <h2 className="text-xl sm:text-2xl font-extrabold text-slate-900 flex items-center gap-2">
            <ScrollText className="w-6 h-6 text-blue-600" />
            업로드 로그
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            현장 담당자가 자료를 제출할 때마다 기록되는 저장 이력입니다.
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-blue-600' : ''}`} />
          <span>새로고침</span>
        </button>
      </div>

      {/* 집계 — 필터를 걸면 그 결과를 셉니다. 필터를 걸었는데 위 숫자가 계속
          전체를 가리키면, 그 숫자를 그대로 보고서에 옮겨 적는 사람이 생깁니다.
          아무 조건도 없을 때만 서버의 최근 30일 집계를 보여 줍니다. */}
      {(narrowed || summary) && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          {[
            {
              label: narrowed ? '조회된 제출' : '최근 30일 제출',
              value: `${narrowed ? visibleLogs.length : summary!.total}건`,
              tone: 'text-slate-900',
            },
            {
              label: '성공',
              value: `${narrowed ? counts.success : summary!.success}건`,
              tone: 'text-emerald-700',
            },
            {
              label: '실패 / 일부 실패',
              value: `${narrowed ? counts.failed + counts.partial : summary!.failed + summary!.partial}건`,
              tone:
                (narrowed ? counts.failed + counts.partial : summary!.failed + summary!.partial) > 0
                  ? 'text-red-700'
                  : 'text-slate-900',
            },
            {
              label: narrowed ? '조회된 파일 / 용량' : '누적 파일 / 용량',
              value: narrowed
                ? `${counts.fileCount}개 · ${formatBytes(counts.totalBytes)}`
                : `${summary!.fileCount}개 · ${formatBytes(summary!.totalBytes)}`,
              tone: 'text-slate-900',
            },
          ].map((card) => (
            <div key={card.label} className="bg-white rounded-xl border border-slate-200 p-4">
              <p className="text-[11px] text-slate-500 font-medium">{card.label}</p>
              <p className={`text-lg font-extrabold mt-1 ${card.tone}`}>{card.value}</p>
            </div>
          ))}
        </div>
      )}

      <RecordFilterBar
        value={filters}
        onChange={setFilters}
        constructionTypes={typeOptions}
        technicians={technicianOptions}
        matched={visibleLogs.length}
        total={logs.length}
        onExport={exportExcel}
      />

      {/* Result filter */}
      <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg text-xs font-medium w-fit mb-4">
        {FILTERS.map((option) => (
          <button
            key={option.label}
            type="button"
            onClick={() => setFilter(option.value)}
            className={`px-3 py-1.5 rounded-md transition-colors ${
              filter === option.value
                ? 'bg-white text-slate-900 shadow-xs font-bold'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800 mb-4">
          <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        {visibleLogs.length === 0 && !isLoading ? (
          <p className="py-16 text-center text-xs text-slate-400">기록된 업로드 로그가 없습니다.</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {visibleLogs.map((log) => {
              const style = RESULT_STYLE[log.result] ?? RESULT_STYLE.FAILED;
              const isOpen = expanded === log.id;

              return (
                <div key={log.id}>
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : log.id)}
                    className="w-full flex items-start gap-3 px-4 sm:px-5 py-3.5 hover:bg-slate-50 text-left transition-colors"
                  >
                    <span
                      className={`inline-flex items-center gap-1 shrink-0 px-2 py-0.5 rounded-full text-[11px] font-bold border ${style.className}`}
                    >
                      <style.Icon className="w-3 h-3" />
                      {style.label}
                    </span>

                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-slate-900 truncate">
                        {log.address || '(주소 없음)'}
                      </p>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-slate-500 mt-0.5">
                        {log.constructionType && (
                          <span className="px-1.5 py-0.5 rounded bg-slate-100 font-bold text-slate-700">
                            {log.constructionType}
                          </span>
                        )}
                        <span>{log.managerName}</span>
                        <span className="font-mono">{log.siteId}</span>
                        <span className="inline-flex items-center gap-1">
                          <HardDrive className="w-3 h-3" />
                          {log.fileCount}개 · {formatBytes(log.totalBytes)}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatDuration(log.durationMs)}
                        </span>
                      </div>
                    </div>

                    <div className="shrink-0 text-right">
                      <p className="text-[11px] text-slate-500 font-mono">
                        {new Date(log.at).toLocaleString('ko-KR')}
                      </p>
                      <ChevronDown
                        className={`w-4 h-4 text-slate-400 ml-auto mt-1 transition-transform ${
                          isOpen ? 'rotate-180' : ''
                        }`}
                      />
                    </div>
                  </button>

                  {isOpen && (
                    <div className="px-4 sm:px-5 pb-4 bg-slate-50/70 text-xs space-y-2.5">
                      <p className="text-slate-700 leading-relaxed">{log.message}</p>

                      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 font-mono text-[11px] text-slate-600">
                        <div className="flex gap-2 min-w-0">
                          <dt className="text-slate-400 shrink-0">저장 경로</dt>
                          <dd className="truncate">{log.folderPath}</dd>
                        </div>
                        <div className="flex gap-2">
                          <dt className="text-slate-400 shrink-0">저장 모드</dt>
                          <dd>{log.mode === 'LIVE' ? 'SharePoint' : '테스트 저장'}</dd>
                        </div>
                        <div className="flex gap-2">
                          <dt className="text-slate-400 shrink-0">접속 IP</dt>
                          <dd>{log.clientIp}</dd>
                        </div>
                        <div className="flex gap-2 min-w-0">
                          <dt className="text-slate-400 shrink-0">브라우저</dt>
                          <dd className="truncate" title={log.userAgent}>
                            {log.userAgent || '-'}
                          </dd>
                        </div>
                      </dl>

                      {log.errors.length > 0 && (
                        <div className="p-2.5 rounded-lg bg-red-50 border border-red-200">
                          <p className="text-[11px] font-bold text-red-800 mb-1">
                            실패 상세 ({log.errors.length}건)
                          </p>
                          <ul className="space-y-0.5 text-[11px] text-red-700 font-mono">
                            {log.errors.map((message) => (
                              <li key={message} className="break-all">
                                · {message}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {log.siteId && (
                        <button
                          type="button"
                          onClick={() => onOpenSite(log.siteId)}
                          className="text-[11px] font-semibold text-blue-700 hover:underline"
                        >
                          해당 현장 상세 보기 →
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {cursor && (
          <div className="p-3 border-t border-slate-100 text-center">
            <button
              type="button"
              onClick={() => void load(filter, true, cursor)}
              disabled={isLoading}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700 disabled:opacity-60"
            >
              {isLoading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              <span>더 보기</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
