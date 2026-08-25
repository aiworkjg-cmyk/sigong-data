import React, { useCallback, useEffect, useState } from 'react';
import {
  Check,
  FolderTree,
  Info,
  Loader2,
  Mail,
  Pencil,
  Plus,
  RotateCcw,
  Settings,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { adminApi } from '../api';
import { isMaster } from '../types';
import type { AdminRole } from '../types';

interface AdminSettingsProps {
  role: AdminRole;
}

interface TokenInfo {
  token: string;
  label: string;
  sample: string;
}

/** Matches the server default so [기본값으로 되돌리기] needs no round trip. */
const DEFAULT_RULE = {
  root: '시공현장자료',
  segments: ['{type}', '{yyyy}', '{MM}월', '{MMdd}_{region}_{building}'],
};

/**
 * 설정 — 마스터관리자 전용.
 *
 * Two things live here, both of which change where or how work lands:
 * the folder rule that decides the SharePoint path, and the addresses that
 * receive roster-deletion requests.
 */
export const AdminSettings: React.FC<AdminSettingsProps> = ({ role }) => {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 폴더 규칙
  const [root, setRoot] = useState('');
  const [segments, setSegments] = useState<string[]>([]);
  const [savedRule, setSavedRule] = useState('');
  const [example, setExample] = useState('');
  const [tokens, setTokens] = useState<TokenInfo[]>([]);

  // 삭제 요청 수신 메일
  const [emails, setEmails] = useState<string[]>([]);
  const [emailDraft, setEmailDraft] = useState('');
  const [editingEmail, setEditingEmail] = useState<string | null>(null);
  const [editEmailDraft, setEditEmailDraft] = useState('');

  const readOnly = !isMaster(role);
  const currentRule = JSON.stringify({ root, segments });
  const isDirty = currentRule !== savedRule;

  const load = useCallback(async () => {
    setError(null);
    try {
      const [rule, mail] = await Promise.all([
        adminApi.folderRule(),
        adminApi.deleteRequestEmails(),
      ]);
      setRoot(rule.folderRule.root);
      setSegments(rule.folderRule.segments);
      setSavedRule(JSON.stringify(rule.folderRule));
      setExample(rule.example);
      setTokens(rule.availableTokens);
      setEmails(mail.deleteRequestEmails);
    } catch (err: any) {
      setError(err?.message || '설정을 불러오지 못했습니다.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /* ---------------------------------------------------------------- */
  /* 폴더 규칙                                                          */
  /* ---------------------------------------------------------------- */

  const handleSaveRule = async () => {
    setBusy('rule');
    setError(null);
    try {
      const result = await adminApi.setFolderRule({ root, segments });
      setRoot(result.folderRule.root);
      setSegments(result.folderRule.segments);
      setSavedRule(JSON.stringify(result.folderRule));
      setExample(result.example);
      setNotice('폴더 규칙을 저장했습니다. 다음 제출부터 적용됩니다.');
    } catch (err: any) {
      setError(err?.message || '폴더 규칙 저장에 실패했습니다.');
    } finally {
      setBusy(null);
    }
  };

  const updateSegment = (index: number, value: string) =>
    setSegments(segments.map((segment, position) => (position === index ? value : segment)));

  const removeSegment = (index: number) =>
    setSegments(segments.filter((_, position) => position !== index));

  const insertToken = (index: number, token: string) =>
    updateSegment(index, `${segments[index] ?? ''}${token}`);

  /* ---------------------------------------------------------------- */
  /* 수신 메일                                                          */
  /* ---------------------------------------------------------------- */

  const runEmail = async (key: string, action: () => Promise<{ deleteRequestEmails: string[] }>,
                          message: string) => {
    setBusy(key);
    setError(null);
    try {
      const { deleteRequestEmails } = await action();
      setEmails(deleteRequestEmails);
      setNotice(message);
      return true;
    } catch (err: any) {
      setError(err?.message || '처리에 실패했습니다.');
      return false;
    } finally {
      setBusy(null);
    }
  };

  const handleAddEmail = async (event: React.FormEvent) => {
    event.preventDefault();
    const email = emailDraft.trim();
    if (!email) return;

    const ok = await runEmail('email-new', () => adminApi.addDeleteRequestEmail(email),
      `${email} 을(를) 수신 목록에 추가했습니다.`);
    if (ok) setEmailDraft('');
  };

  const handleUpdateEmail = async (current: string) => {
    const ok = await runEmail(current, () => adminApi.updateDeleteRequestEmail(current, editEmailDraft),
      '수신 주소를 수정했습니다.');
    if (ok) setEditingEmail(null);
  };

  const handleRemoveEmail = async (email: string) => {
    if (!window.confirm(`${email} 을(를) 수신 목록에서 삭제할까요?`)) return;
    await runEmail(email, () => adminApi.removeDeleteRequestEmail(email),
      `${email} 을(를) 삭제했습니다.`);
  };

  return (
    <div className="max-w-4xl mx-auto py-5 sm:py-8 px-3 sm:px-6">
      <div className="mb-5">
        <h2 className="text-lg sm:text-2xl font-extrabold text-slate-900 flex items-center gap-2">
          <Settings className="w-5 h-5 sm:w-6 sm:h-6 text-blue-600 shrink-0" />
          설정
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          마스터관리자만 변경할 수 있는 운영 설정입니다.
        </p>
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

      <div className="flex items-start gap-2 p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-600 mb-4">
        <Info className="w-4 h-4 shrink-0 mt-0.5 text-slate-400" />
        <span>
          시공종류는 좌측 <strong>[시공종류 관리]</strong>, 시공기사는{' '}
          <strong>[시공기사 관리]</strong> 화면에서 관리합니다.
        </span>
      </div>

      {/* ============================ 폴더 생성 규칙 ============================ */}
      <div className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-6 mb-4">
        <h3 className="text-base font-bold text-slate-900 mb-1 flex items-center gap-2">
          <FolderTree className="w-4 h-4 text-blue-600" />
          폴더 생성 규칙
        </h3>
        <p className="text-xs text-slate-500 mb-4">
          제출된 자료가 SharePoint 어느 경로에 저장될지 정합니다.
        </p>

        {/* 미리보기 */}
        <div className="rounded-xl bg-slate-900 text-slate-100 p-3 mb-4 overflow-x-auto">
          <p className="text-[11px] text-slate-400 mb-1">저장 경로 미리보기</p>
          <p className="font-mono text-xs sm:text-sm whitespace-nowrap">
            {example || '불러오는 중...'}
          </p>
        </div>

        {/* 최상위 폴더 */}
        <label className="block mb-4">
          <span className="block text-xs font-bold text-slate-700 mb-1.5">
            최상위 폴더
            <span className="ml-1.5 font-normal text-slate-400">
              (문서함 바로 아래. Teams 채널로 보내려면 <code>채널이름/시공현장자료</code>)
            </span>
          </span>
          <input
            type="text"
            value={root}
            onChange={(event) => setRoot(event.target.value)}
            disabled={readOnly}
            placeholder="예: 시공현장자료"
            className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-50"
          />
        </label>

        {/* 폴더 단계 */}
        <span className="block text-xs font-bold text-slate-700 mb-1.5">
          하위 폴더 단계
          <span className="ml-1.5 font-normal text-slate-400">(위에서부터 순서대로)</span>
        </span>
        <div className="space-y-2 mb-3">
          {segments.map((segment, index) => (
            <div key={index} className="flex items-center gap-2">
              <span className="w-6 text-center text-[11px] font-bold text-slate-400 shrink-0">
                {index + 1}
              </span>
              <input
                type="text"
                value={segment}
                onChange={(event) => updateSegment(index, event.target.value)}
                disabled={readOnly}
                className="flex-1 min-w-0 px-3 py-2 rounded-lg border border-slate-300 font-mono text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-50"
              />
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => removeSegment(index)}
                  disabled={segments.length <= 1}
                  className="p-2 rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40 shrink-0"
                  title={segments.length <= 1 ? '최소 1단계는 필요합니다' : '이 단계 삭제'}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          ))}
        </div>

        {!readOnly && (
          <>
            <button
              type="button"
              onClick={() => setSegments([...segments, ''])}
              className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:text-blue-900 mb-4"
            >
              <Plus className="w-3.5 h-3.5" />
              단계 추가
            </button>

            {/* 항목 사전 — 마지막 칸에 붙여 넣습니다. */}
            <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 mb-4">
              <p className="text-[11px] font-bold text-slate-600 mb-2">
                쓸 수 있는 항목 — 누르면 마지막 단계에 추가됩니다
              </p>
              <div className="flex flex-wrap gap-1.5">
                {tokens.map((info) => (
                  <button
                    key={info.token}
                    type="button"
                    onClick={() => insertToken(segments.length - 1, info.token)}
                    title={`${info.label} → ${info.sample}`}
                    className="px-2 py-1 rounded-md bg-white border border-slate-300 hover:border-blue-400 hover:bg-blue-50 font-mono text-[11px] text-slate-700"
                  >
                    {info.token}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-slate-500 mt-2">
                항목 위에 마우스를 올리면 무슨 값이 들어가는지 보입니다. 빈 값이 나오면 앞뒤
                구분기호(_)는 자동으로 정리됩니다.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void handleSaveRule()}
                disabled={busy === 'rule' || !isDirty}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-bold"
              >
                {busy === 'rule' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Check className="w-3.5 h-3.5" />
                )}
                저장
              </button>
              <button
                type="button"
                onClick={() => {
                  setRoot(DEFAULT_RULE.root);
                  setSegments([...DEFAULT_RULE.segments]);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-xs font-semibold text-slate-700"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                기본값
              </button>
              {isDirty && (
                <span className="text-[11px] font-semibold text-amber-700">
                  저장하지 않은 변경이 있습니다
                </span>
              )}
            </div>
          </>
        )}

        <div className="mt-4 flex items-start gap-2 text-[11px] text-slate-500 border-t border-slate-100 pt-3">
          <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-slate-400" />
          <span>
            규칙을 바꿔도 <strong>이미 저장된 폴더는 옮겨지지 않습니다.</strong> 다음 제출부터
            적용되므로, 운영 중에 자주 바꾸면 같은 현장 자료가 여러 위치로 흩어집니다.
          </span>
        </div>
      </div>

      {/* ======================= 삭제 요청 수신 메일 ======================= */}
      <div className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-6">
        <h3 className="text-base font-bold text-slate-900 mb-1 flex items-center gap-2">
          <Mail className="w-4 h-4 text-blue-600" />
          삭제 요청 수신 메일
        </h3>
        <p className="text-xs text-slate-500 mb-4">
          업체 관리자가 시공기사 삭제를 시도하면, 여기 등록된{' '}
          <strong>전원에게</strong> 요청 메일이 발송됩니다.
        </p>

        {!readOnly && (
          <form onSubmit={handleAddEmail} className="flex flex-wrap items-center gap-2 mb-4">
            <input
              type="email"
              value={emailDraft}
              onChange={(event) => setEmailDraft(event.target.value)}
              placeholder="예: admin@urotech.co.kr"
              className="flex-1 min-w-[200px] px-3 py-2.5 rounded-lg border border-slate-300 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              type="submit"
              disabled={busy === 'email-new' || !emailDraft.trim()}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-bold"
            >
              {busy === 'email-new' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Plus className="w-3.5 h-3.5" />
              )}
              추가
            </button>
          </form>
        )}

        {emails.length === 0 ? (
          <div className="flex items-start gap-2 p-4 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
            <Info className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              등록된 주소가 없습니다. 지금은 삭제 요청 시 &quot;마스터관리자에게 문의&quot; 로만
              안내됩니다.
            </span>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100 border border-slate-200 rounded-xl overflow-hidden">
            {emails.map((email) => {
              const isEditing = editingEmail === email;
              const isBusy = busy === email;

              return (
                <li key={email} className="flex items-center gap-2 px-3 py-2.5">
                  <Mail className="w-4 h-4 text-slate-400 shrink-0" />

                  {isEditing ? (
                    <input
                      type="email"
                      value={editEmailDraft}
                      onChange={(event) => setEditEmailDraft(event.target.value)}
                      className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  ) : (
                    <span className="flex-1 min-w-0 text-sm font-semibold text-slate-800 truncate">
                      {email}
                    </span>
                  )}

                  {!readOnly && (
                    <div className="flex items-center gap-1 shrink-0">
                      {isEditing ? (
                        <>
                          <button
                            type="button"
                            onClick={() => void handleUpdateEmail(email)}
                            disabled={isBusy}
                            className="p-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-60"
                            title="저장"
                          >
                            {isBusy ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Check className="w-4 h-4" />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingEmail(null)}
                            className="p-2 rounded-lg border border-slate-300 text-slate-500 hover:bg-slate-50"
                            title="취소"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingEmail(email);
                              setEditEmailDraft(email);
                            }}
                            className="p-2 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                            title="수정"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleRemoveEmail(email)}
                            disabled={isBusy}
                            className="p-2 rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-60"
                            title="삭제"
                          >
                            {isBusy ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Trash2 className="w-4 h-4" />
                            )}
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {emails.length > 0 && (
          <p className="mt-3 text-[11px] text-slate-500">
            현재 <strong>{emails.length}명</strong>이 등록되어 있습니다. 삭제 요청 창에도 이
            목록이 그대로 표시되어, 요청자가 누구에게 가는지 알 수 있습니다.
          </p>
        )}
      </div>
    </div>
  );
};
