import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Database,
  FolderTree,
  Home,
  Loader2,
  RefreshCw,
  ServerCog,
  X,
  XCircle,
} from 'lucide-react';
import { adminApi, type Diagnostics } from '../api';
import type { FolderEntry } from '../types';

interface AdminDiagnosticsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

function formatBytes(bytes?: number): string {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

/**
 * Connection status, the active folder-classification rule, and a live browser
 * of the document library — the three things an admin needs when a submission
 * has not landed where it was expected.
 */
export const AdminDiagnosticsModal: React.FC<AdminDiagnosticsModalProps> = ({ isOpen, onClose }) => {
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [entries, setEntries] = useState<FolderEntry[]>([]);
  const [path, setPath] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const browse = useCallback(async (target: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await adminApi.folders(target);
      setEntries(result.entries);
      setPath(target);
    } catch (err: any) {
      setError(err?.message || '폴더를 불러오지 못했습니다.');
      setEntries([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await adminApi.diagnostics();
      setDiagnostics(result);
      await browse(result.sharePoint.rootFolder);
    } catch (err: any) {
      setError(err?.message || '진단 정보를 불러오지 못했습니다.');
    } finally {
      setIsLoading(false);
    }
  }, [browse]);

  useEffect(() => {
    if (isOpen) void load();
  }, [isOpen, load]);

  if (!isOpen) return null;

  const sp = diagnostics?.sharePoint;
  const rule = sp?.folderRule;
  const segments = path.split('/').filter(Boolean);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/70 backdrop-blur-xs"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden shadow-2xl border border-slate-200"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-slate-50">
          <div className="flex items-center gap-2.5">
            <ServerCog className="w-5 h-5 text-blue-600" />
            <div>
              <h3 className="text-base font-bold text-slate-900">저장소 연동 상태 및 폴더 구조</h3>
              <p className="text-xs text-slate-500">
                SharePoint 연결, 분류 규칙, 실제 저장 폴더를 확인합니다.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void load()}
              className="p-2 rounded-lg hover:bg-slate-200 text-slate-500"
              title="새로고침"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-2 rounded-lg hover:bg-slate-200 text-slate-500"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {error && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
              <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {diagnostics?.warnings.map((warning) => (
            <div
              key={warning}
              className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900"
            >
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{warning}</span>
            </div>
          ))}

          {/* Connection summary */}
          <section className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="p-4 rounded-xl border border-slate-200 bg-slate-50">
              <div className="flex items-center gap-2 mb-2">
                <FolderTree className="w-4 h-4 text-blue-600" />
                <span className="text-xs font-bold text-slate-700">파일 저장소</span>
              </div>
              <p className="text-sm font-bold text-slate-900">
                {sp?.mode === 'LIVE' ? 'Microsoft SharePoint (실제 연동)' : '테스트 저장 모드'}
              </p>
              <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">{sp?.message}</p>
              {diagnostics?.connectivity && (
                <div
                  className={`mt-2 flex items-center gap-1.5 text-[11px] font-semibold ${
                    diagnostics.connectivity.ok ? 'text-emerald-700' : 'text-red-700'
                  }`}
                >
                  {diagnostics.connectivity.ok ? (
                    <>
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>연결 정상 — {diagnostics.connectivity.driveName || '문서 라이브러리'}</span>
                    </>
                  ) : (
                    <>
                      <XCircle className="w-3.5 h-3.5" />
                      <span className="break-all">{diagnostics.connectivity.error}</span>
                    </>
                  )}
                </div>
              )}
            </div>

            <div className="p-4 rounded-xl border border-slate-200 bg-slate-50">
              <div className="flex items-center gap-2 mb-2">
                <Database className="w-4 h-4 text-purple-600" />
                <span className="text-xs font-bold text-slate-700">기록 저장소</span>
              </div>
              <p className="text-sm font-bold text-slate-900">
                {diagnostics?.recordBackend === 'AZURE_TABLES'
                  ? 'Azure Table Storage'
                  : '로컬 JSON 파일'}
              </p>
              <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">
                현장 기록·업로드 로그·이슈가 저장되는 위치입니다.
              </p>
            </div>
          </section>

          {/* Active classification rule */}
          {rule && (
            <section className="p-4 rounded-xl border border-blue-200 bg-blue-50/60">
              <h4 className="text-xs font-bold text-blue-900 mb-2">현재 폴더 분류 규칙</h4>
              <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-mono">
                <span className="px-2 py-1 rounded bg-white border border-blue-200 text-blue-900 font-bold">
                  {rule.root}
                </span>
                {rule.segments.map((segment) => (
                  <React.Fragment key={segment}>
                    <ChevronRight className="w-3 h-3 text-blue-400" />
                    <span className="px-2 py-1 rounded bg-white border border-blue-200 text-blue-900">
                      {segment}
                    </span>
                  </React.Fragment>
                ))}
                {rule.attachmentsFolder && (
                  <>
                    <ChevronRight className="w-3 h-3 text-blue-400" />
                    <span className="px-2 py-1 rounded bg-white border border-blue-200 text-blue-900">
                      {rule.attachmentsFolder}
                    </span>
                  </>
                )}
              </div>
              <p className="text-[11px] text-blue-800 mt-2.5">
                실제 저장 예시:{' '}
                <span className="font-mono break-all">{sp?.examplePath}</span>
              </p>
              <p className="text-[11px] text-blue-700/80 mt-1.5 leading-relaxed">
                규칙은 <span className="font-mono">SHAREPOINT_FOLDER_SEGMENTS</span> 환경변수로 변경할 수
                있습니다. 사용 가능한 항목: {'{yyyy} {MM} {dd} {date} {sido} {sigungu} {address} {manager} {siteId} {quarter}'}
              </p>
            </section>
          )}

          {/* Live folder browser */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-xs font-bold text-slate-700">저장 폴더 탐색</h4>
              {isLoading && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />}
            </div>

            {/* Breadcrumb */}
            <div className="flex items-center flex-wrap gap-1 text-[11px] mb-2 font-mono">
              <button
                type="button"
                onClick={() => void browse(sp?.rootFolder || '')}
                className="p-1 rounded hover:bg-slate-100 text-slate-500"
                title="최상위로"
              >
                <Home className="w-3.5 h-3.5" />
              </button>
              {segments.map((segment, index) => (
                <React.Fragment key={`${segment}-${index}`}>
                  <ChevronRight className="w-3 h-3 text-slate-300" />
                  <button
                    type="button"
                    onClick={() => void browse(segments.slice(0, index + 1).join('/'))}
                    className="px-1.5 py-0.5 rounded hover:bg-slate-100 text-slate-700"
                  >
                    {segment}
                  </button>
                </React.Fragment>
              ))}
            </div>

            <div className="border border-slate-200 rounded-xl divide-y divide-slate-100 max-h-64 overflow-y-auto">
              {entries.length === 0 && !isLoading ? (
                <p className="p-6 text-center text-xs text-slate-400">
                  이 폴더에는 항목이 없습니다.
                </p>
              ) : (
                entries.map((entry) => (
                  <div
                    key={entry.name}
                    className="flex items-center justify-between px-3.5 py-2.5 hover:bg-slate-50"
                  >
                    <button
                      type="button"
                      disabled={entry.type !== 'folder'}
                      onClick={() => void browse(path ? `${path}/${entry.name}` : entry.name)}
                      className={`flex items-center gap-2 min-w-0 text-left text-xs ${
                        entry.type === 'folder'
                          ? 'text-blue-700 font-semibold hover:underline'
                          : 'text-slate-700 cursor-default'
                      }`}
                    >
                      {entry.type === 'folder' ? (
                        <FolderTree className="w-3.5 h-3.5 shrink-0 text-blue-500" />
                      ) : (
                        <span className="w-3.5 shrink-0 text-center text-slate-400">·</span>
                      )}
                      <span className="truncate">{entry.name}</span>
                    </button>
                    <span className="text-[11px] text-slate-400 font-mono shrink-0 ml-3">
                      {entry.type === 'file' ? formatBytes(entry.size) : '폴더'}
                    </span>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};
