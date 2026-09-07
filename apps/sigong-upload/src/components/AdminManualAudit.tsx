import React, { useEffect, useMemo, useState } from 'react';
import { Download, FileWarning, Loader2, RefreshCw } from 'lucide-react';
import { adminApi } from '../api';
import type { ManualAuditEntry } from '../types';

const ACTION_LABELS: Record<ManualAuditEntry['action'], { text: string; className: string }> = {
  ADDED: { text: '직접 추가', className: 'bg-blue-100 text-blue-800' },
  DELETED: { text: '직접 삭제', className: 'bg-rose-100 text-rose-800' },
  RENAMED: { text: '이름 정리', className: 'bg-slate-100 text-slate-700' },
};

function stamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * 앱을 거치지 않은 SharePoint 변경 기록.
 *
 * 업로드 로그와 왜 따로 두는가: 업로드 로그는 "이 사이트를 통해 무엇이
 * 올라갔는가"의 기록이고, 여기 있는 것은 "그 폴더에서 누가 앱 밖에서 무엇을
 * 건드렸는가"의 기록입니다. 둘을 한 화면에 섞으면 사고가 났을 때 어느 쪽이
 * 원인인지 가려내는 데 시간이 걸립니다. 기록 자체도 별도 파일에 한 줄씩
 * 덧붙여 저장하므로, 앱 데이터가 초기화돼도 남습니다.
 */
export const AdminManualAudit: React.FC = () => {
  const [entries, setEntries] = useState<ManualAuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<ManualAuditEntry['action'] | ''>('');
  const [search, setSearch] = useState('');

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const { entries: found } = await adminApi.manualAudit();
      setEntries(found);
    } catch (err: any) {
      setError(err?.message || '기록을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return entries.filter((entry) => {
      if (action && entry.action !== action) return false;
      if (!needle) return true;
      return [entry.name, entry.path, entry.by, entry.note]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });
  }, [entries, action, search]);

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-2 mb-1">
        <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
          <FileWarning className="w-4 h-4 text-amber-600" />
          수동 변경 기록
          <span className="text-xs font-semibold text-slate-500">
            {visible.length}건{visible.length !== entries.length && ` / 전체 ${entries.length}건`}
          </span>
        </h3>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => void adminApi.exportManualAudit()}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs font-semibold text-slate-600"
          >
            <Download className="w-3.5 h-3.5" />
            엑셀
          </button>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            aria-label="새로고침"
            className="p-2 rounded-lg border border-slate-300 text-slate-500 disabled:opacity-50"
          >
            {loading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>
      <p className="text-xs text-slate-500 mb-3">
        이 사이트를 거치지 않고 SharePoint에서 직접 올리거나 지운 흔적입니다. 사이트를 통한
        업로드는 <strong>업로드 로그</strong>에 남습니다.
      </p>

      <div className="flex flex-wrap gap-2 mb-3">
        {(['', 'ADDED', 'DELETED', 'RENAMED'] as const).map((value) => (
          <button
            key={value || 'all'}
            type="button"
            onClick={() => setAction(value)}
            className={`px-2.5 py-1.5 rounded-lg border text-xs font-semibold ${
              action === value
                ? 'border-slate-900 bg-slate-900 text-white'
                : 'border-slate-300 text-slate-600'
            }`}
          >
            {value ? ACTION_LABELS[value].text : '전체'}
          </button>
        ))}
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="파일 · 경로 · 작업자"
          className="flex-1 min-w-[160px] px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs"
        />
      </div>

      {error && (
        <p className="mb-3 px-3 py-2 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-800">
          {error}
        </p>
      )}

      {!loading && visible.length === 0 ? (
        <p className="py-8 text-center text-xs text-slate-400">
          기록이 없습니다. 앱 밖에서 폴더를 건드린 적이 없다는 뜻입니다.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-400 border-b border-slate-200">
                {['시각', '동작', '파일', '경로', '작업자', '내용'].map((label) => (
                  <th key={label} className="px-3 py-2 font-semibold whitespace-nowrap">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {visible.map((entry) => (
                <tr key={`${entry.at}-${entry.itemId}-${entry.action}`}>
                  <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{stamp(entry.at)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span
                      className={`px-1.5 py-0.5 rounded font-bold ${ACTION_LABELS[entry.action].className}`}
                    >
                      {ACTION_LABELS[entry.action].text}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-semibold text-slate-800">{entry.name}</td>
                  <td className="px-3 py-2 text-slate-500 break-all">{entry.path}</td>
                  <td className="px-3 py-2 text-slate-600 whitespace-nowrap">
                    {entry.by || '확인되지 않음'}
                  </td>
                  <td className="px-3 py-2 text-slate-500">{entry.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
