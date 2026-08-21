import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Info,
  Loader2,
  Plus,
  RefreshCw,
  Settings,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { adminApi } from '../api';
import { canEdit } from '../types';
import type { AdminRole } from '../types';

interface AdminSettingsProps {
  role: AdminRole;
  /** Lets the public submission form pick up the change without a reload. */
  onConstructionTypesChanged: (types: string[]) => void;
}

/**
 * Runtime settings screen.
 *
 * 시공종류 doubles as a folder name in the document library, so the list is
 * edited here rather than typed by submitters. Removing a type only stops it
 * being offered from now on — folders already created keep their name.
 */
export const AdminSettings: React.FC<AdminSettingsProps> = ({
  role,
  onConstructionTypesChanged,
}) => {
  const [types, setTypes] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const readOnly = !canEdit(role);

  const apply = useCallback(
    (list: string[]) => {
      setTypes(list);
      onConstructionTypesChanged(list);
    },
    [onConstructionTypesChanged]
  );

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const { constructionTypes } = await adminApi.constructionTypes();
      apply(constructionTypes);
    } catch (err: any) {
      setError(err?.message || '시공종류 목록을 불러오지 못했습니다.');
    } finally {
      setIsLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleAdd = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = draft.trim();
    if (!name) return;

    setBusy('new');
    setError(null);
    try {
      const { constructionTypes } = await adminApi.addConstructionType(name);
      apply(constructionTypes);
      setDraft('');
      setNotice(`시공종류 "${name}" 을(를) 추가했습니다.`);
    } catch (err: any) {
      setError(err?.message || '시공종류 추가에 실패했습니다.');
    } finally {
      setBusy(null);
    }
  };

  const handleRemove = async (name: string) => {
    const confirmed = window.confirm(
      `시공종류 "${name}" 을(를) 목록에서 삭제할까요?\n\n` +
        '· 제출 화면에서 더 이상 선택할 수 없게 됩니다.\n' +
        '· 이미 저장된 자료와 폴더는 그대로 유지됩니다.'
    );
    if (!confirmed) return;

    setBusy(name);
    setError(null);
    try {
      const { constructionTypes } = await adminApi.removeConstructionType(name);
      apply(constructionTypes);
      setNotice(`시공종류 "${name}" 을(를) 삭제했습니다.`);
    } catch (err: any) {
      setError(err?.message || '시공종류 삭제에 실패했습니다.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="max-w-4xl mx-auto py-6 sm:py-8 px-4 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <h2 className="text-xl sm:text-2xl font-extrabold text-slate-900 flex items-center gap-2">
            <Settings className="w-6 h-6 text-blue-600" />
            설정
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            제출 화면에서 선택할 수 있는 시공종류를 관리합니다.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-blue-600' : ''}`} />
          <span>새로고침</span>
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800 mb-4">
          <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span className="flex-1">{error}</span>
          <button type="button" onClick={() => setError(null)}>
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {notice && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 mb-4">
          <span className="flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice(null)}>
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div className="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6">
        <h3 className="text-base font-bold text-slate-900 mb-1">시공종류</h3>
        <p className="text-xs text-slate-500 mb-4">
          여기에 등록된 항목만 제출 화면에 버튼으로 표시되고, 그대로 저장 폴더 이름이 됩니다.
        </p>

        {readOnly ? (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-600 mb-4">
            <Info className="w-4 h-4 shrink-0 mt-0.5 text-slate-400" />
            <span>일반 권한 계정은 목록을 볼 수만 있습니다. 변경은 관리자에게 요청해 주세요.</span>
          </div>
        ) : (
          <form onSubmit={handleAdd} className="flex flex-wrap items-center gap-2 mb-5">
            <input
              type="text"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="추가할 시공종류 (예: 리바트)"
              maxLength={30}
              className="flex-1 min-w-[200px] px-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              type="submit"
              disabled={busy === 'new' || !draft.trim()}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-bold"
            >
              {busy === 'new' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Plus className="w-3.5 h-3.5" />
              )}
              <span>추가</span>
            </button>
          </form>
        )}

        {types.length === 0 ? (
          <div className="flex items-start gap-2 p-4 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              등록된 시공종류가 없습니다. 최소 1개를 추가해야 현장 담당자가 자료를 제출할 수
              있습니다.
            </span>
          </div>
        ) : (
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {types.map((type) => (
              <li
                key={type}
                className="flex items-center justify-between gap-2 px-3.5 py-2.5 rounded-xl border border-slate-200 bg-slate-50"
              >
                <span className="text-sm font-bold text-slate-800 truncate">{type}</span>
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => void handleRemove(type)}
                    disabled={busy === type || types.length <= 1}
                    title={
                      types.length <= 1 ? '마지막 시공종류는 삭제할 수 없습니다.' : '시공종류 삭제'
                    }
                    className="p-1.5 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-600 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-slate-400"
                  >
                    {busy === type ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Trash2 className="w-4 h-4" />
                    )}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="mt-5 flex items-start gap-2 text-[11px] text-slate-500 border-t border-slate-100 pt-4">
          <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-slate-400" />
          <span>
            삭제해도 이미 저장된 자료와 SharePoint 폴더는 그대로 남습니다. 변경 내용은 저장 즉시
            제출 화면에 반영됩니다.
          </span>
        </div>
      </div>
    </div>
  );
};
