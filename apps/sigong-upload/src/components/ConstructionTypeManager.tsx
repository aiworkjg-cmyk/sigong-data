import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Info, Loader2, Plus, RefreshCw, Tags, Trash2, X, XCircle } from 'lucide-react';
import { adminApi } from '../api';
import { typeStyle } from '../constructionTypes';

interface ConstructionTypeManagerProps {
  /** Keeps the public submission form in step without a reload. */
  onChanged: () => void;
}

/** Mirrors the server's romanizer so the id prefix is visible before saving. */
function previewCode(name: string): string {
  const INITIALS = ['G','KK','N','D','TT','R','M','B','PP','S','SS','','J','JJ','CH','K','T','P','H'];
  const MEDIALS = ['A','AE','YA','YAE','EO','E','YEO','YE','O','WA','WAE','OE','YO','U','WO','WE','WI','YU','EU','UI','I'];
  const FINALS = ['','K','K','K','N','N','N','T','L','K','M','P','T','T','P','L','M','P','P','T','T','NG','T','T','K','T','P','T'];

  let out = '';
  for (const char of name) {
    const code = char.charCodeAt(0);
    if (code >= 0xac00 && code <= 0xd7a3) {
      const offset = code - 0xac00;
      out += INITIALS[Math.floor(offset / 588)];
      out += MEDIALS[Math.floor(offset / 28) % 21];
      out += FINALS[offset % 28];
    } else if (/[A-Za-z0-9]/.test(char)) {
      out += char.toUpperCase();
    }
  }
  return out.slice(0, 12) || 'ETC';
}

/**
 * 시공종류 관리 — master only.
 *
 * A 시공종류 is load-bearing: it becomes a folder name, the colour a row is
 * tagged with, and the prefix of every 현장 ID filed under it. The generated id
 * prefix is shown next to each entry so that consequence is visible here rather
 * than discovered later in SharePoint.
 */
export const ConstructionTypeManager: React.FC<ConstructionTypeManagerProps> = ({ onChanged }) => {
  const [types, setTypes] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const { constructionTypes } = await adminApi.constructionTypes();
      setTypes(constructionTypes);
      onChanged();
    } catch (err: any) {
      setError(err?.message || '시공종류 목록을 불러오지 못했습니다.');
    } finally {
      setIsLoading(false);
    }
  }, [onChanged]);

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
      setTypes(constructionTypes);
      onChanged();
      setDraft('');
      setNotice(`"${name}" 을(를) 추가했습니다. 현장 ID는 ${previewCode(name)}-… 로 생성됩니다.`);
    } catch (err: any) {
      setError(err?.message || '시공종류 추가에 실패했습니다.');
    } finally {
      setBusy(null);
    }
  };

  const handleRemove = async (name: string) => {
    const confirmed = window.confirm(
      `시공종류 "${name}" 을(를) 삭제할까요?\n\n` +
        '· 제출 화면에서 더 이상 선택할 수 없게 됩니다.\n' +
        '· 이미 저장된 자료와 폴더, 현장 ID는 그대로 유지됩니다.'
    );
    if (!confirmed) return;

    setBusy(name);
    setError(null);
    try {
      const { constructionTypes } = await adminApi.removeConstructionType(name);
      setTypes(constructionTypes);
      onChanged();
      setNotice(`"${name}" 을(를) 삭제했습니다.`);
    } catch (err: any) {
      setError(err?.message || '시공종류 삭제에 실패했습니다.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="max-w-3xl mx-auto py-5 sm:py-8 px-3 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div className="min-w-0">
          <h2 className="text-lg sm:text-2xl font-extrabold text-slate-900 flex items-center gap-2">
            <Tags className="w-5 h-5 sm:w-6 sm:h-6 text-blue-600 shrink-0" />
            시공종류 관리
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            제출 화면에서 선택할 수 있는 업체·제품 목록입니다.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-blue-600' : ''}`} />
          <span className="hidden sm:inline">새로고침</span>
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

      <div className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5">
        <form onSubmit={handleAdd} className="flex flex-wrap items-center gap-2 mb-4">
          <input
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="추가할 시공종류 (예: 리바트)"
            maxLength={30}
            className="flex-1 min-w-[200px] px-3 py-2.5 rounded-lg border border-slate-300 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            type="submit"
            disabled={busy === 'new' || !draft.trim()}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-bold"
          >
            {busy === 'new' ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Plus className="w-3.5 h-3.5" />
            )}
            <span>추가</span>
          </button>
        </form>

        {draft.trim() && (
          <p className="-mt-2 mb-4 text-[11px] text-slate-500">
            현장 ID 형식 미리보기:{' '}
            <span className="font-mono font-bold text-slate-700">
              {previewCode(draft.trim())}-20260824-001
            </span>
          </p>
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
          <ul className="divide-y divide-slate-100">
            {types.map((type) => {
              const style = typeStyle(type);
              return (
                <li key={type} className="flex items-center gap-2.5 py-2.5">
                  <span className={`w-1.5 h-8 rounded-full shrink-0 ${style.accent}`} />
                  <span
                    className={`px-2.5 py-1 rounded-lg border text-sm font-bold ${style.chip}`}
                  >
                    {type}
                  </span>
                  <span className="text-[11px] font-mono text-slate-400 truncate">
                    {previewCode(type)}-…-001
                  </span>
                  <span className="flex-1" />
                  <button
                    type="button"
                    onClick={() => void handleRemove(type)}
                    disabled={busy === type || types.length <= 1}
                    title={types.length <= 1 ? '마지막 시공종류는 삭제할 수 없습니다.' : '삭제'}
                    className="p-2 rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-slate-400 shrink-0"
                  >
                    {busy === type ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Trash2 className="w-4 h-4" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <div className="mt-4 flex items-start gap-2 text-[11px] text-slate-500 border-t border-slate-100 pt-3">
          <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-slate-400" />
          <span>
            색상은 이름에서 자동으로 정해지며 항상 같은 색이 유지됩니다. 삭제해도 이미 저장된
            자료·폴더·현장 ID는 그대로 남고, 앞으로 선택만 되지 않습니다.
          </span>
        </div>
      </div>
    </div>
  );
};
