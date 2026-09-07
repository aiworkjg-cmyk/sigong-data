import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, CheckCircle2, Loader2, Plus, Sparkles, Tag, Trash2, X, XCircle } from 'lucide-react';
import { adminApi } from '../api';
import type { ConstructionTypeConfig } from '../types';

interface ConstructionTypeFieldsProps {
  /** 이 계정이 다룰 수 있는 시공종류. */
  allowedTypes: string[];
}

/**
 * 항목 이름에서 폴더 토큰을 만듭니다. 서버와 같은 규칙이라 화면에 보이는 값이
 * 곧 저장되는 값입니다. 한글을 그대로 씁니다 — {주문번호} 가 읽히는 형태입니다.
 */
function tokenFromLabel(label: string): string {
  return label
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .replace(/^[-]+/, '')
    .slice(0, 30);
}

/**
 * 시공종류별 입력 항목.
 *
 * 폴더 규칙과 갈라 놓은 이유: 이 둘은 고치는 사람도 주기도 다릅니다. 입력
 * 항목은 업체가 새 정보를 요구할 때마다 손대고, 폴더 규칙은 한 번 정하면
 * 거의 건드리지 않습니다. 자주 여는 쪽을 시공기사·시공종류와 같은 화면에 두면
 * "누가 어떤 현장을 어떤 정보로 맡는가"가 한자리에서 끝납니다.
 *
 * 현장종류는 여기서 손으로 채우지 않아도 됩니다 — 주문서를 연동하거나 올리면
 * 시트 탭 이름이 선택값으로 자동으로 들어옵니다.
 */
export const ConstructionTypeFields: React.FC<ConstructionTypeFieldsProps> = ({ allowedTypes }) => {
  const [configs, setConfigs] = useState<ConstructionTypeConfig[]>([]);
  const [selected, setSelected] = useState('');
  const [draft, setDraft] = useState<ConstructionTypeConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const { configs: found } = await adminApi.constructionTypeConfigs();
      const mine = found.filter(
        (entry) => allowedTypes.length === 0 || allowedTypes.includes(entry.constructionType)
      );
      setConfigs(mine);
      setSelected((current) => current || mine[0]?.constructionType || '');
    } catch (err: any) {
      setFeedback({ kind: 'error', text: err?.message || '입력 항목을 불러오지 못했습니다.' });
    }
  }, [allowedTypes]);

  useEffect(() => {
    void load();
  }, [load]);

  // 고른 시공종류가 바뀌면 편집본을 새로 뜹니다.
  useEffect(() => {
    const found = configs.find((entry) => entry.constructionType === selected);
    setDraft(found ? structuredClone(found) : null);
  }, [selected, configs]);

  const updateField = (id: string, patch: Partial<ConstructionTypeConfig['fields'][number]>) => {
    if (!draft) return;
    setDraft({
      ...draft,
      fields: draft.fields.map((field) => {
        if (field.id !== id) return field;
        const next = { ...field, ...patch };
        // 토큰은 이름을 따라가되, 사람이 직접 고친 뒤에는 따라가지 않습니다.
        if (patch.label !== undefined && patch.token === undefined) {
          const wasDerived = !field.token || field.token === tokenFromLabel(field.label);
          if (wasDerived) next.token = tokenFromLabel(patch.label);
        }
        return next;
      }),
    });
  };

  const addField = () => {
    if (!draft) return;
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    setDraft({
      ...draft,
      fields: [
        ...draft.fields,
        { id: `field-${suffix}`, label: '', token: '', inputType: 'text', required: false, options: [] },
      ],
    });
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setFeedback(null);
    try {
      const { config } = await adminApi.setConstructionTypeConfig(selected, draft);
      setConfigs((items) =>
        items.map((item) => (item.constructionType === selected ? config : item))
      );
      setDraft(structuredClone(config));
      setFeedback({ kind: 'ok', text: `${selected} 입력 항목을 저장했습니다.` });
    } catch (err: any) {
      setFeedback({ kind: 'error', text: err?.message || '저장에 실패했습니다.' });
    } finally {
      setBusy(false);
    }
  };

  const siteTypeCount = useMemo(
    () => draft?.fields.find((field) => field.token === 'siteType')?.options.length ?? 0,
    [draft]
  );

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-6">
      <h3 className="text-base font-bold text-slate-900 mb-1">시공종류별 입력 항목</h3>
      <p className="text-xs text-slate-500 mb-4">
        제출 화면에서 시공종류를 고른 뒤 나타날 칸입니다. 폴더가 만들어지는 방식은{' '}
        <strong>[설정] &gt; 시공종류별 폴더 규칙</strong>에서 따로 정합니다.
      </p>

      {feedback && (
        <div
          className={`flex items-start gap-2 p-3 rounded-lg border text-xs mb-4 ${
            feedback.kind === 'error'
              ? 'bg-red-50 border-red-200 text-red-800'
              : 'bg-emerald-50 border-emerald-200 text-emerald-800'
          }`}
        >
          {feedback.kind === 'error' ? (
            <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
          ) : (
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
          )}
          <span className="flex-1">{feedback.text}</span>
          <button type="button" onClick={() => setFeedback(null)} aria-label="닫기">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div className="flex flex-wrap gap-2 mb-4">
        {configs.map((entry) => {
          const on = entry.constructionType === selected;
          return (
            <button
              key={entry.constructionType}
              type="button"
              onClick={() => setSelected(entry.constructionType)}
              className={`px-3 py-2 rounded-xl border text-xs font-bold ${
                on
                  ? 'border-blue-500 bg-blue-600 text-white'
                  : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400'
              }`}
            >
              {entry.constructionType}
              <span className={`ml-1.5 font-semibold ${on ? 'text-blue-100' : 'text-slate-400'}`}>
                {entry.fields.length > 0 ? `입력 ${entry.fields.length}` : '입력 없음'}
              </span>
            </button>
          );
        })}
        {configs.length === 0 && (
          <p className="text-xs text-slate-500">등록된 시공종류가 없습니다. 위에서 먼저 추가해 주세요.</p>
        )}
      </div>

      {draft && (
        <div className="space-y-3 border-t border-slate-100 pt-4">
          {siteTypeCount > 0 && (
            <p className="flex items-start gap-1.5 rounded-lg bg-blue-50 px-2.5 py-2 text-[11px] text-blue-900">
              <Sparkles className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>
                현장종류 <strong>{siteTypeCount}개</strong>가 주문서에서 자동으로 등록되어 있습니다.
                시트에 탭이 늘면 여기도 따라 늘어납니다.
              </span>
            </p>
          )}

          {draft.fields.map((field, index) => {
            const token = field.token || tokenFromLabel(field.label);
            const auto = field.token === 'siteType';
            return (
              <div key={field.id} className="rounded-xl border border-slate-200 p-3">
                <div className="grid sm:grid-cols-[1fr_150px_auto_auto] gap-2 items-end">
                  <label>
                    <span className="block text-xs font-bold text-slate-700 mb-1">항목 이름</span>
                    <input
                      value={field.label}
                      onChange={(event) => updateField(field.id, { label: event.target.value })}
                      placeholder="예: 현장종류, 주문번호"
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm"
                    />
                  </label>
                  <label>
                    <span className="block text-xs font-bold text-slate-700 mb-1">입력 방식</span>
                    <select
                      value={field.inputType}
                      onChange={(event) =>
                        updateField(field.id, {
                          inputType: event.target.value as 'text' | 'select',
                          options: event.target.value === 'text' ? [] : field.options,
                        })
                      }
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm"
                    >
                      <option value="text">직접 입력</option>
                      <option value="select">검색 후 선택</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-2 pb-2 text-xs font-semibold">
                    <input
                      type="checkbox"
                      checked={field.required}
                      onChange={(event) => updateField(field.id, { required: event.target.checked })}
                    />
                    필수
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      setDraft({ ...draft, fields: draft.fields.filter((entry) => entry.id !== field.id) })
                    }
                    className="p-2 text-slate-400 hover:text-red-600"
                    title="삭제"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                {field.inputType === 'select' && (
                  <label className="block mt-2">
                    <span className="block text-xs font-bold text-slate-700 mb-1">
                      선택값 (한 줄에 하나)
                      {auto && (
                        <span className="ml-1.5 font-normal text-blue-600">
                          주문서에서 자동으로 채워집니다
                        </span>
                      )}
                    </span>
                    <textarea
                      rows={auto ? 5 : 3}
                      value={field.options.join('\n')}
                      onChange={(event) =>
                        updateField(field.id, { options: event.target.value.split('\n') })
                      }
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm"
                      placeholder={'롯데부산점\n현대목동'}
                    />
                  </label>
                )}

                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <label className="flex-1 min-w-[180px]">
                    <span className="flex items-center gap-1 text-xs font-bold text-slate-700 mb-1">
                      <Tag className="w-3.5 h-3.5 text-slate-400" />
                      폴더 토큰
                    </span>
                    <input
                      value={field.token}
                      onChange={(event) => updateField(field.id, { token: event.target.value })}
                      placeholder={tokenFromLabel(field.label) || '예: 주문번호'}
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 font-mono text-xs"
                    />
                  </label>
                  <p className="text-[11px] text-slate-500 pb-2">
                    폴더 규칙에 쓸 때: <code>{`{${token || '토큰'}}`}</code> · 표시 순서 {index + 1}
                  </p>
                </div>
              </div>
            );
          })}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={addField}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-blue-300 text-blue-700 text-xs font-bold"
            >
              <Plus className="w-3.5 h-3.5" />
              입력 항목 추가
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-blue-600 text-white text-xs font-bold disabled:opacity-50"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              입력 항목 저장
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
