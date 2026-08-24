import React, { useCallback, useEffect, useState } from 'react';
import {
  Crown,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserPlus,
  X,
  XCircle,
} from 'lucide-react';
import { adminApi } from '../api';
import { titleStyle } from '../technicians';
import { ASSIGNABLE_ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS, isMaster } from '../types';
import type { AdminSession, AdminUser, AssignableRole, Technician } from '../types';

const MIN_PASSWORD_LENGTH = 10;

interface AdminAccountsProps {
  session: AdminSession;
}

interface Draft {
  username: string;
  displayName: string;
  password: string;
  role: AssignableRole;
  constructionTypes: string[];
  technicianId: string;
}

const EMPTY_DRAFT: Draft = {
  username: '',
  displayName: '',
  password: '',
  role: 'TECH',
  constructionTypes: [],
  technicianId: '',
};

/**
 * 계정 관리.
 *
 * The master sees and edits everyone. A 업체 관리자 reaches the same screen but
 * the server hands back only the 시공기사 accounts it created, and rejects any
 * attempt to mint a peer — so the narrowed UI here is a convenience, not the
 * security boundary.
 */
export const AdminAccounts: React.FC<AdminAccountsProps> = ({ session }) => {
  const [accounts, setAccounts] = useState<AdminUser[]>([]);
  const [technicians, setTechnicians] = useState<Technician[]>([]);
  const [constructionTypes, setConstructionTypes] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [isComposing, setIsComposing] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);

  const master = isMaster(session.role);
  const availableRoles = master ? ASSIGNABLE_ROLES : (['TECH'] as const);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [{ accounts: list }, { technicians: roster }] = await Promise.all([
        adminApi.accounts(),
        adminApi.technicians(),
      ]);
      setAccounts(list);
      setTechnicians(roster);
    } catch (err: any) {
      setError(err?.message || '계정 목록을 불러오지 못했습니다.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    if (master) {
      adminApi
        .constructionTypes()
        .then(({ constructionTypes: types }) => setConstructionTypes(types))
        .catch(() => undefined);
    }
  }, [load, master]);

  const technicianName = (id?: string) => {
    const tech = technicians.find((candidate) => candidate.id === id);
    return tech ? `${tech.name} (${tech.title})` : '연결된 기사 없음';
  };

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();

    if (draft.password.length < MIN_PASSWORD_LENGTH) {
      setError(`비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.`);
      return;
    }
    if (draft.role === 'TECH' && !draft.technicianId) {
      setError('시공기사 계정은 명부에서 기사를 지정해야 합니다.');
      return;
    }
    if (draft.role === 'COMPANY' && draft.constructionTypes.length === 0) {
      setError('관리자 계정은 담당 시공종류를 1개 이상 선택해야 합니다.');
      return;
    }

    setBusy('new');
    setError(null);
    try {
      const { accounts: list } = await adminApi.createAccount({
        username: draft.username,
        displayName: draft.displayName,
        password: draft.password,
        role: draft.role,
        constructionTypes: draft.role === 'COMPANY' ? draft.constructionTypes : undefined,
        technicianId: draft.role === 'TECH' ? draft.technicianId : undefined,
      });
      setAccounts(list);
      setDraft(EMPTY_DRAFT);
      setIsComposing(false);
      setNotice(`${draft.username} 계정을 만들었습니다. 아이디와 비밀번호를 전달해 주세요.`);
    } catch (err: any) {
      setError(err?.message || '계정 추가에 실패했습니다.');
    } finally {
      setBusy(null);
    }
  };

  const patch = async (
    account: AdminUser,
    body: Parameters<typeof adminApi.updateAccount>[1],
    message: string
  ) => {
    setBusy(account.username);
    setError(null);
    try {
      const { accounts: list } = await adminApi.updateAccount(account.username, body);
      setAccounts(list);
      setNotice(message);
    } catch (err: any) {
      setError(err?.message || '변경에 실패했습니다.');
    } finally {
      setBusy(null);
    }
  };

  const handleResetPassword = async (account: AdminUser) => {
    const password = window.prompt(
      `${account.username} 계정의 새 비밀번호를 입력하세요. (${MIN_PASSWORD_LENGTH}자 이상)`
    );
    if (!password) return;
    await patch(account, { password }, `${account.username} 계정의 비밀번호를 변경했습니다.`);
  };

  const handleDelete = async (account: AdminUser) => {
    if (!window.confirm(`${account.username} 계정을 삭제할까요? 되돌릴 수 없습니다.`)) return;

    setBusy(account.username);
    setError(null);
    try {
      const { accounts: list } = await adminApi.deleteAccount(account.username);
      setAccounts(list);
      setNotice(`${account.username} 계정을 삭제했습니다.`);
    } catch (err: any) {
      setError(err?.message || '계정 삭제에 실패했습니다.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="max-w-4xl mx-auto py-5 sm:py-8 px-3 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div className="min-w-0">
          <h2 className="text-lg sm:text-2xl font-extrabold text-slate-900 flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 sm:w-6 sm:h-6 text-purple-600 shrink-0" />
            계정 관리
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            {master
              ? '계정을 만들고 아이디·비밀번호를 전달해 주세요. 권한에 따라 볼 수 있는 자료가 달라집니다.'
              : '내가 만든 시공기사 계정만 표시됩니다.'}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-blue-600' : ''}`} />
            <span className="hidden sm:inline">새로고침</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setIsComposing((prev) => !prev);
              setDraft({ ...EMPTY_DRAFT, role: master ? 'COMPANY' : 'TECH' });
            }}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold"
          >
            {isComposing ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
            <span>{isComposing ? '취소' : '계정 추가'}</span>
          </button>
        </div>
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

      {isComposing && (
        <form
          onSubmit={handleCreate}
          className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 mb-4 space-y-3.5"
        >
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1.5">권한</label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {availableRoles.map((role) => {
                const selected = draft.role === role;
                return (
                  <button
                    key={role}
                    type="button"
                    onClick={() => setDraft({ ...draft, role })}
                    className={`text-left px-3 py-2.5 rounded-lg border-2 transition-colors ${
                      selected
                        ? 'border-blue-600 bg-blue-50'
                        : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}
                  >
                    <span
                      className={`block text-sm font-bold ${selected ? 'text-blue-800' : 'text-slate-800'}`}
                    >
                      {ROLE_LABELS[role]}
                    </span>
                    <span className="block text-[11px] text-slate-500 mt-0.5">
                      {ROLE_DESCRIPTIONS[role]}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Scope — differs entirely by role. */}
          {draft.role === 'COMPANY' ? (
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">
                담당 시공종류 <span className="font-normal text-slate-400">(여러 개 선택 가능)</span>
              </label>
              <div className="flex flex-wrap gap-1.5">
                {constructionTypes.map((type) => {
                  const selected = draft.constructionTypes.includes(type);
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() =>
                        setDraft({
                          ...draft,
                          constructionTypes: selected
                            ? draft.constructionTypes.filter((value) => value !== type)
                            : [...draft.constructionTypes, type],
                        })
                      }
                      className={`px-3 py-1.5 rounded-lg border-2 text-xs font-bold transition-colors ${
                        selected
                          ? 'border-blue-600 bg-blue-50 text-blue-800'
                          : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                      }`}
                    >
                      {type}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">
                연결할 시공기사
              </label>
              <select
                value={draft.technicianId}
                onChange={(e) => {
                  const tech = technicians.find((candidate) => candidate.id === e.target.value);
                  setDraft({
                    ...draft,
                    technicianId: e.target.value,
                    // Default the display name to the roster name — it is what
                    // 시공현황 리스트 greets them with.
                    displayName: draft.displayName || tech?.name || '',
                  });
                }}
                required
                className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-sm bg-white"
              >
                <option value="">명부에서 선택...</option>
                {technicians.map((tech) => (
                  <option key={tech.id} value={tech.id}>
                    {tech.name} ({tech.title})
                  </option>
                ))}
              </select>
              {technicians.length === 0 && (
                <p className="mt-1 text-[11px] text-amber-700">
                  명부가 비어 있습니다. [시공기사 관리]에서 먼저 기사를 등록해 주세요.
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">아이디</label>
              <input
                type="text"
                value={draft.username}
                onChange={(e) => setDraft({ ...draft, username: e.target.value })}
                placeholder="예: baekjo01"
                autoComplete="off"
                required
                className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">표시 이름</label>
              <input
                type="text"
                value={draft.displayName}
                onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
                placeholder="예: 홍길동"
                className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1.5">
              비밀번호 ({MIN_PASSWORD_LENGTH}자 이상)
            </label>
            <input
              type="password"
              value={draft.password}
              onChange={(e) => setDraft({ ...draft, password: e.target.value })}
              autoComplete="new-password"
              required
              className="w-full px-3 py-2.5 rounded-lg border border-slate-300 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="mt-1 text-[11px] text-slate-500">
              비밀번호는 해시로만 보관되어 나중에 다시 볼 수 없습니다. 지금 적어 두었다가 본인에게
              전달하고, 분실 시에는 재설정하세요.
            </p>
          </div>

          <button
            type="submit"
            disabled={busy === 'new'}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-xs font-bold"
          >
            {busy === 'new' ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <UserPlus className="w-3.5 h-3.5" />
            )}
            <span>계정 추가</span>
          </button>
        </form>
      )}

      <div className="bg-white rounded-2xl border border-slate-200 divide-y divide-slate-100 overflow-hidden">
        {accounts.length === 0 && !isLoading ? (
          <p className="py-16 text-center text-xs text-slate-400">계정이 없습니다.</p>
        ) : (
          accounts.map((account) => {
            const accountIsMaster = account.role === 'MASTER';
            const isSelf = account.username === session.username;
            const isBusy = busy === account.username;
            const tech = technicians.find((candidate) => candidate.id === account.technicianId);

            return (
              <div key={account.username} className="px-3 sm:px-4 py-3.5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-bold text-slate-900">
                        {account.displayName}
                      </span>
                      <span className="text-xs font-mono text-slate-500">
                        ({account.username})
                      </span>
                      {accountIsMaster ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-purple-100 text-purple-800 border border-purple-200">
                          <Crown className="w-3 h-3" />
                          {ROLE_LABELS.MASTER}
                        </span>
                      ) : (
                        <span
                          className={`px-2 py-0.5 rounded-full text-[11px] font-bold border ${
                            account.role === 'COMPANY'
                              ? 'bg-blue-50 text-blue-800 border-blue-200'
                              : 'bg-slate-100 text-slate-700 border-slate-300'
                          }`}
                        >
                          {ROLE_LABELS[account.role]}
                        </span>
                      )}
                      {isSelf && (
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                          현재 로그인
                        </span>
                      )}
                      {account.disabled && (
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-red-100 text-red-800 border border-red-200">
                          사용 중지
                        </span>
                      )}
                    </div>

                    {/* Scope */}
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {account.role === 'COMPANY' &&
                        (account.constructionTypes.length > 0 ? (
                          account.constructionTypes.map((type) => (
                            <span
                              key={type}
                              className="px-2 py-0.5 rounded-md bg-slate-800 text-white text-[11px] font-bold"
                            >
                              {type}
                            </span>
                          ))
                        ) : (
                          <span className="text-[11px] font-semibold text-amber-700">
                            담당 시공종류 미지정 — 조회 불가
                          </span>
                        ))}

                      {account.role === 'TECH' &&
                        (tech ? (
                          <span
                            className={`px-2 py-0.5 rounded-md border text-[11px] font-bold ${titleStyle(tech.title).chip}`}
                          >
                            {tech.name} · {tech.title}
                          </span>
                        ) : (
                          <span className="text-[11px] font-semibold text-amber-700">
                            {technicianName(account.technicianId)} — 마스터가 지정 필요
                          </span>
                        ))}
                    </div>

                    <p className="text-[11px] text-slate-400 mt-1">
                      {accountIsMaster
                        ? '환경변수로 관리되는 계정입니다. 변경하려면 배포 설정을 수정하세요.'
                        : `등록 ${account.createdAt ? new Date(account.createdAt).toLocaleDateString('ko-KR') : '-'} · 등록자 ${account.createdBy}`}
                      {account.lastLoginAt &&
                        ` · 최근 로그인 ${new Date(account.lastLoginAt).toLocaleString('ko-KR')}`}
                    </p>
                  </div>

                  {!accountIsMaster && (
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => void handleResetPassword(account)}
                        disabled={isBusy}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-[11px] font-semibold text-slate-700 disabled:opacity-60"
                      >
                        <KeyRound className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">비밀번호</span>
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void patch(
                            account,
                            { disabled: !account.disabled },
                            `${account.username} 계정을 ${account.disabled ? '사용' : '중지'} 처리했습니다.`
                          )
                        }
                        disabled={isBusy}
                        className="px-2.5 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-[11px] font-semibold text-slate-700 disabled:opacity-60"
                      >
                        {account.disabled ? '사용 재개' : '중지'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(account)}
                        disabled={isBusy}
                        className="p-1.5 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-600 disabled:opacity-60"
                        title="계정 삭제"
                      >
                        {isBusy ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Trash2 className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                  )}
                </div>

                {/* Master-only scope editing */}
                {master && !accountIsMaster && (
                  <div className="mt-2.5 pt-2.5 border-t border-slate-100 flex flex-wrap items-center gap-2">
                    <span className="text-[11px] font-bold text-slate-500">권한 변경</span>
                    <select
                      value={account.role === 'COMPANY' ? 'COMPANY' : 'TECH'}
                      onChange={(e) =>
                        void patch(
                          account,
                          { role: e.target.value as AssignableRole },
                          `${account.username} 계정의 권한을 변경했습니다.`
                        )
                      }
                      disabled={isBusy}
                      className="px-2 py-1 rounded-lg border border-slate-300 bg-white text-[11px] font-semibold text-slate-700"
                    >
                      {ASSIGNABLE_ROLES.map((role) => (
                        <option key={role} value={role}>
                          {ROLE_LABELS[role]}
                        </option>
                      ))}
                    </select>

                    {account.role === 'COMPANY' && (
                      <div className="flex flex-wrap gap-1">
                        {constructionTypes.map((type) => {
                          const on = account.constructionTypes.includes(type);
                          return (
                            <button
                              key={type}
                              type="button"
                              disabled={isBusy}
                              onClick={() =>
                                void patch(
                                  account,
                                  {
                                    constructionTypes: on
                                      ? account.constructionTypes.filter((v) => v !== type)
                                      : [...account.constructionTypes, type],
                                  },
                                  `${account.username} 계정의 담당 시공종류를 변경했습니다.`
                                )
                              }
                              className={`px-2 py-1 rounded-md border text-[11px] font-bold transition-colors ${
                                on
                                  ? 'bg-slate-800 text-white border-slate-800'
                                  : 'bg-white text-slate-500 border-slate-300 hover:border-slate-400'
                              }`}
                            >
                              {type}
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {account.role === 'TECH' && (
                      <select
                        value={account.technicianId || ''}
                        onChange={(e) =>
                          void patch(
                            account,
                            { technicianId: e.target.value },
                            `${account.username} 계정의 연결 기사를 변경했습니다.`
                          )
                        }
                        disabled={isBusy}
                        className="px-2 py-1 rounded-lg border border-slate-300 bg-white text-[11px] font-semibold text-slate-700"
                      >
                        <option value="">기사 선택...</option>
                        {technicians.map((candidate) => (
                          <option key={candidate.id} value={candidate.id}>
                            {candidate.name} ({candidate.title})
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
