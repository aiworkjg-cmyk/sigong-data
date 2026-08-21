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
import { ASSIGNABLE_ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS } from '../types';
import type { AdminUser, AssignableRole } from '../types';

const MIN_PASSWORD_LENGTH = 10;

interface AdminAccountsProps {
  /** Username of the signed-in admin, so the current account is marked. */
  currentUsername: string;
}

/**
 * Account management, reachable only by the master account.
 *
 * The master itself is defined by environment configuration and is shown here
 * read-only — it cannot be edited or removed from the UI, which is what keeps
 * a mistake in this screen from locking everyone out.
 */
export const AdminAccounts: React.FC<AdminAccountsProps> = ({ currentUsername }) => {
  const [accounts, setAccounts] = useState<AdminUser[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [isComposing, setIsComposing] = useState(false);
  const [draft, setDraft] = useState<{
    username: string;
    displayName: string;
    password: string;
    role: AssignableRole;
  }>({ username: '', displayName: '', password: '', role: 'ADMIN' });

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const { accounts: list } = await adminApi.accounts();
      setAccounts(list);
    } catch (err: any) {
      setError(err?.message || '계정 목록을 불러오지 못했습니다.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (draft.password.length < MIN_PASSWORD_LENGTH) {
      setError(`비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.`);
      return;
    }

    setBusy('new');
    setError(null);
    try {
      await adminApi.createAccount(draft);
      setDraft({ username: '', displayName: '', password: '', role: 'ADMIN' });
      setIsComposing(false);
      setNotice('계정이 추가되었습니다.');
      await load();
    } catch (err: any) {
      setError(err?.message || '계정 추가에 실패했습니다.');
    } finally {
      setBusy(null);
    }
  };

  const handleToggle = async (account: AdminUser) => {
    setBusy(account.username);
    setError(null);
    try {
      const { accounts: list } = await adminApi.updateAccount(account.username, {
        disabled: !account.disabled,
      });
      setAccounts(list);
      setNotice(`${account.username} 계정을 ${account.disabled ? '사용' : '중지'} 처리했습니다.`);
    } catch (err: any) {
      setError(err?.message || '상태 변경에 실패했습니다.');
    } finally {
      setBusy(null);
    }
  };

  const handleRoleChange = async (account: AdminUser, role: AssignableRole) => {
    setBusy(account.username);
    setError(null);
    try {
      const { accounts: list } = await adminApi.updateAccount(account.username, { role });
      setAccounts(list);
      setNotice(`${account.username} 계정의 권한을 ${ROLE_LABELS[role]}(으)로 변경했습니다.`);
    } catch (err: any) {
      setError(err?.message || '권한 변경에 실패했습니다.');
    } finally {
      setBusy(null);
    }
  };

  const handleResetPassword = async (account: AdminUser) => {
    const password = window.prompt(
      `${account.username} 계정의 새 비밀번호를 입력하세요. (${MIN_PASSWORD_LENGTH}자 이상)`
    );
    if (!password) return;

    setBusy(account.username);
    setError(null);
    try {
      await adminApi.updateAccount(account.username, { password });
      setNotice(`${account.username} 계정의 비밀번호를 변경했습니다.`);
    } catch (err: any) {
      setError(err?.message || '비밀번호 변경에 실패했습니다.');
    } finally {
      setBusy(null);
    }
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
    <div className="max-w-4xl mx-auto py-6 sm:py-8 px-4 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <h2 className="text-xl sm:text-2xl font-extrabold text-slate-900 flex items-center gap-2">
            <ShieldCheck className="w-6 h-6 text-purple-600" />
            관리자 계정
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            <span className="font-semibold text-slate-700">관리자</span>는 자료·이슈·설정을 변경할 수
            있고, <span className="font-semibold text-slate-700">일반</span>은 조회만 가능합니다.
            계정 관리는 마스터만 할 수 있습니다.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-blue-600' : ''}`} />
            <span>새로고침</span>
          </button>
          <button
            type="button"
            onClick={() => setIsComposing((prev) => !prev)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold"
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
          className="bg-white rounded-2xl border border-slate-200 p-5 mb-5 space-y-3"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">아이디</label>
              <input
                type="text"
                value={draft.username}
                onChange={(event) => setDraft({ ...draft, username: event.target.value })}
                placeholder="영문·숫자 3~32자"
                autoComplete="off"
                required
                className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">표시 이름</label>
              <input
                type="text"
                value={draft.displayName}
                onChange={(event) => setDraft({ ...draft, displayName: event.target.value })}
                placeholder="예: 김대리"
                className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1.5">권한</label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {ASSIGNABLE_ROLES.map((role) => {
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

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1.5">
              비밀번호 ({MIN_PASSWORD_LENGTH}자 이상)
            </label>
            <input
              type="password"
              value={draft.password}
              onChange={(event) => setDraft({ ...draft, password: event.target.value })}
              autoComplete="new-password"
              required
              className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="mt-1 text-[11px] text-slate-500">
              비밀번호는 저장되지 않고 해시로만 보관됩니다. 분실 시 재설정만 가능합니다.
            </p>
          </div>
          <button
            type="submit"
            disabled={busy === 'new'}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-xs font-bold"
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
            const isMaster = account.role === 'MASTER';
            const isSelf = account.username === currentUsername;
            const isBusy = busy === account.username;

            return (
              <div
                key={account.username}
                className="flex flex-wrap items-center justify-between gap-3 px-4 sm:px-5 py-4"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-bold text-slate-900">{account.displayName}</span>
                    <span className="text-xs font-mono text-slate-500">({account.username})</span>
                    {isMaster ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-purple-100 text-purple-800 border border-purple-200">
                        <Crown className="w-3 h-3" />
                        {ROLE_LABELS.MASTER}
                      </span>
                    ) : (
                      <span
                        className={`px-2 py-0.5 rounded-full text-[11px] font-bold border ${
                          account.role === 'ADMIN'
                            ? 'bg-blue-50 text-blue-800 border-blue-200'
                            : 'bg-slate-100 text-slate-700 border-slate-300'
                        }`}
                      >
                        {ROLE_LABELS[account.role]}
                      </span>
                    )}
                    {isSelf && (
                      <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-blue-50 text-blue-700 border border-blue-200">
                        현재 로그인
                      </span>
                    )}
                    {account.disabled && (
                      <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-red-100 text-red-800 border border-red-200">
                        사용 중지
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-400 mt-1">
                    {isMaster
                      ? '환경변수로 관리되는 계정입니다. 변경하려면 배포 설정을 수정하세요.'
                      : `등록 ${new Date(account.createdAt).toLocaleDateString('ko-KR')} · 등록자 ${account.createdBy}`}
                    {account.lastLoginAt &&
                      ` · 최근 로그인 ${new Date(account.lastLoginAt).toLocaleString('ko-KR')}`}
                  </p>
                </div>

                {!isMaster && (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <select
                      value={account.role === 'STAFF' ? 'STAFF' : 'ADMIN'}
                      onChange={(event) =>
                        void handleRoleChange(account, event.target.value as AssignableRole)
                      }
                      disabled={isBusy}
                      title="권한 변경"
                      className="px-2 py-1.5 rounded-lg border border-slate-300 bg-white text-[11px] font-semibold text-slate-700 disabled:opacity-60"
                    >
                      {ASSIGNABLE_ROLES.map((role) => (
                        <option key={role} value={role}>
                          {ROLE_LABELS[role]}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => void handleResetPassword(account)}
                      disabled={isBusy}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-[11px] font-semibold text-slate-700 disabled:opacity-60"
                    >
                      <KeyRound className="w-3.5 h-3.5" />
                      비밀번호 재설정
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleToggle(account)}
                      disabled={isBusy}
                      className="px-2.5 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-[11px] font-semibold text-slate-700 disabled:opacity-60"
                    >
                      {account.disabled ? '사용 재개' : '사용 중지'}
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
            );
          })
        )}
      </div>
    </div>
  );
};
