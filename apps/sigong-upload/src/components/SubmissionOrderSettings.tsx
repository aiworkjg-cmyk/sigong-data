import React, { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Check, ListOrdered, Loader2, Minus, Plus, RotateCcw } from 'lucide-react';
import { adminApi } from '../api';
import {
  DEFAULT_SUBMISSION_ORDER,
  SUBMISSION_FIELDS,
  submissionFieldMeta,
  type SubmissionFieldKey,
} from '../submission-layout';

/**
 * 자료 업로드 화면의 입력 항목 차례를 정하는 설정.
 *
 * 위/아래 버튼으로만 옮깁니다. 끌어놓기가 더 자연스러워 보이지만, 이 화면은
 * 태블릿에서도 열리고 손가락으로 끄는 조작은 스크롤과 자주 부딪힙니다. 항목이
 * 여덟 개뿐이라 버튼 몇 번이면 끝납니다.
 */
export const SubmissionOrderSettings: React.FC<{ constructionTypes: string[] }> = ({
  constructionTypes,
}) => {
  const [orders, setOrders] = useState<Record<string, SubmissionFieldKey[]>>({});
  const [saved, setSaved] = useState<Record<string, SubmissionFieldKey[]>>({});
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    void adminApi
      .submissionOrders()
      .then(({ orders: stored }) => {
        setOrders(stored);
        setSaved(stored);
      })
      .catch(() => {});
  }, []);

  // 고른 시공종류가 목록에서 사라지면(삭제·이름 변경) 첫 번째로 되돌립니다.
  useEffect(() => {
    if (!constructionTypes.includes(selected)) setSelected(constructionTypes[0] ?? '');
  }, [constructionTypes, selected]);

  const order = orders[selected] ?? DEFAULT_SUBMISSION_ORDER;
  const dirty = order.join('|') !== (saved[selected] ?? DEFAULT_SUBMISSION_ORDER).join('|');

  const setOrder = (next: SubmissionFieldKey[]) =>
    setOrders((current) => ({ ...current, [selected]: next }));

  /** 아직 쓰지 않는 항목. 목록이 정해져 있으므로 언제든 다시 넣을 수 있습니다. */
  const available = SUBMISSION_FIELDS.filter((meta) => !order.includes(meta.key));

  const move = (index: number, step: -1 | 1) => {
    const target = index + step;
    // 시공종류는 늘 맨 앞입니다 — 나머지가 모두 그 값에서 갈라지므로 뒤로
    // 보낼 수 있게 두면 그 자체로 고장 난 화면이 됩니다.
    if (target < 1 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    setOrder(next);
    setNote(null);
  };

  const save = async () => {
    if (!selected) return;
    setBusy(true);
    setNote(null);
    try {
      const { order: stored } = await adminApi.setSubmissionOrder(selected, order);
      setOrders((current) => ({ ...current, [selected]: stored }));
      setSaved((current) => ({ ...current, [selected]: stored }));
      setNote({
        kind: 'ok',
        text: `${selected} 입력 항목 차례를 저장했습니다. 기사 화면을 새로고침하면 바뀝니다.`,
      });
    } catch (err: any) {
      setNote({ kind: 'error', text: err?.message || '저장하지 못했습니다.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-6 mb-4">
      <h3 className="text-base font-bold text-slate-900 flex items-center gap-2 mb-1">
        <ListOrdered className="w-4 h-4 text-blue-600" />
        자료 업로드 입력 항목 차례
      </h3>
      <p className="text-xs text-slate-500 mb-3">
        기사 화면에서 항목이 나오는 순서입니다. 번호 순으로 위에서 아래로 그려지며,
        <strong> 시공종류마다 따로</strong> 정합니다.
      </p>

      {/* 어느 업체의 차례를 고치는 중인지가 늘 보여야 합니다 — 안 그러면
          한 업체를 고친 줄 알고 다른 업체를 바꿔 놓게 됩니다. */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {constructionTypes.map((type) => (
          <button
            key={type}
            type="button"
            onClick={() => {
              setSelected(type);
              setNote(null);
            }}
            className={`px-3 py-1.5 rounded-lg border text-xs font-bold ${
              selected === type
                ? 'border-blue-600 bg-blue-600 text-white'
                : 'border-slate-300 text-slate-600'
            }`}
          >
            {type}
          </button>
        ))}
      </div>

      {note && (
        <p
          className={`mb-3 px-3 py-2 rounded-lg text-xs ${
            note.kind === 'ok'
              ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
              : 'bg-rose-50 text-rose-800 border border-rose-200'
          }`}
        >
          {note.text}
        </p>
      )}

      <ol className="rounded-xl border border-slate-200 overflow-hidden divide-y divide-slate-100">
        {order.map((key, index) => {
          const meta = submissionFieldMeta(key);
          return (
            <li key={key} className="flex items-center gap-3 px-3 py-2.5">
              <span className="w-6 h-6 shrink-0 rounded-full bg-slate-900 text-white text-xs font-bold grid place-items-center">
                {index + 1}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-slate-900">
                  {meta.label}
                  {meta.fixed && (
                    <span className="ml-1.5 px-1.5 py-0.5 rounded bg-slate-100 text-[10px] font-semibold text-slate-500">
                      고정
                    </span>
                  )}
                  {meta.manualOnly && (
                    <span className="ml-1.5 px-1.5 py-0.5 rounded bg-amber-100 text-[10px] font-semibold text-amber-800">
                      직접 입력일 때만
                    </span>
                  )}
                </p>
                <p className="text-[11px] text-slate-500">{meta.hint}</p>
              </div>
              <div className="flex shrink-0 gap-1">
                <button
                  type="button"
                  onClick={() => setOrder(order.filter((other) => other !== key))}
                  disabled={Boolean(meta.required)}
                  aria-label={`${meta.label} 빼기`}
                  title={meta.required ? '이 항목은 뺄 수 없습니다.' : '이 항목 빼기'}
                  className="p-1.5 rounded-lg border border-slate-300 text-rose-500 disabled:opacity-30 disabled:text-slate-300"
                >
                  <Minus className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => move(index, -1)}
                  disabled={index <= 1}
                  aria-label={`${meta.label} 위로`}
                  className="p-1.5 rounded-lg border border-slate-300 text-slate-500 disabled:opacity-30"
                >
                  <ArrowUp className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => move(index, 1)}
                  disabled={index === 0 || index === order.length - 1}
                  aria-label={`${meta.label} 아래로`}
                  className="p-1.5 rounded-lg border border-slate-300 text-slate-500 disabled:opacity-30"
                >
                  <ArrowDown className="w-3.5 h-3.5" />
                </button>
              </div>
            </li>
          );
        })}
      </ol>

      {/*
       * 뺀 항목을 늘 보여 줍니다.
       *
       * 여기 있는 것은 관리자가 지어내는 값이 아니라 정해진 목록입니다. 뺀 뒤에
       * 무엇이 있었는지 화면 어디에도 남지 않으면, 다시 넣고 싶어도 이름을
       * 기억해 내야 하고 결국 "기본 차례로"를 눌러 전부 되돌리게 됩니다.
       */}
      <div className="mt-3 rounded-xl border border-dashed border-slate-300 p-3">
        <p className="text-[11px] font-bold text-slate-500 mb-2">
          추가할 수 있는 항목
          {available.length === 0 && (
            <span className="ml-1 font-semibold text-slate-400">— 모두 쓰고 있습니다.</span>
          )}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {available.map((meta) => (
            <button
              key={meta.key}
              type="button"
              onClick={() => setOrder([...order, meta.key])}
              title={meta.hint}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-600 hover:border-blue-400 hover:text-blue-700"
            >
              <Plus className="w-3 h-3" />
              {meta.label}
              {meta.manualOnly && (
                <span className="text-[10px] font-bold text-amber-700">직접 입력</span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mt-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || !dirty}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-blue-600 text-white text-xs font-bold disabled:opacity-40"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
          차례 저장
        </button>
        <button
          type="button"
          onClick={() => {
            setOrder([...DEFAULT_SUBMISSION_ORDER]);
            setNote(null);
          }}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 text-xs font-semibold text-slate-600"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          기본 차례로
        </button>
        {dirty && <span className="text-[11px] text-amber-700">저장하지 않은 변경이 있습니다.</span>}
      </div>
    </div>
  );
};
