import React, { useEffect, useState } from 'react';
import { Info, Loader2, Mail, Settings, X, XCircle } from 'lucide-react';
import { adminApi } from '../api';
import { isMaster } from '../types';
import type { AdminRole } from '../types';

interface AdminSettingsProps {
  role: AdminRole;
}

/**
 * Runtime settings screen.
 *
 * 시공종류 doubles as a folder name in the document library, so the list is
 * edited here rather than typed by submitters. Removing a type only stops it
 * being offered from now on — folders already created keep their name.
 */
export const AdminSettings: React.FC<AdminSettingsProps> = ({ role }) => {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteEmail, setDeleteEmail] = useState('');
  const [savedDeleteEmail, setSavedDeleteEmail] = useState('');

  const readOnly = !isMaster(role);

  useEffect(() => {
    adminApi
      .technicians()
      .then(({ deleteRequestEmail }) => {
        setDeleteEmail(deleteRequestEmail);
        setSavedDeleteEmail(deleteRequestEmail);
      })
      .catch(() => undefined);
  }, []);

  const handleSaveDeleteEmail = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy('email');
    setError(null);
    try {
      const { deleteRequestEmail } = await adminApi.setDeleteRequestEmail(deleteEmail);
      setDeleteEmail(deleteRequestEmail);
      setSavedDeleteEmail(deleteRequestEmail);
      setNotice(
        deleteRequestEmail
          ? `삭제 요청 수신 메일을 ${deleteRequestEmail} (으)로 설정했습니다.`
          : '삭제 요청 수신 메일을 비웠습니다.'
      );
    } catch (err: any) {
      setError(err?.message || '메일 주소 저장에 실패했습니다.');
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
            마스터관리자만 변경할 수 있는 운영 설정입니다.
          </p>
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

      <div className="flex items-start gap-2 p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-600 mb-4">
        <Info className="w-4 h-4 shrink-0 mt-0.5 text-slate-400" />
        <span>
          시공종류는 좌측 <strong>[시공종류 관리]</strong>, 시공기사는{' '}
          <strong>[시공기사 관리]</strong> 화면에서 관리합니다.
        </span>
      </div>

      {/* 삭제 요청 수신 메일 */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6 mt-4">
        <h3 className="text-base font-bold text-slate-900 mb-1">삭제 요청 수신 메일</h3>
        <p className="text-xs text-slate-500 mb-4">
          업체 관리자가 시공기사 명부에서 삭제를 시도하면, 이 주소로 요청하라는 안내창이 뜹니다.
          비워 두면 &quot;마스터관리자에게 문의&quot; 로만 안내됩니다.
        </p>

        <form onSubmit={handleSaveDeleteEmail} className="flex flex-wrap items-center gap-2">
          <input
            type="email"
            value={deleteEmail}
            onChange={(event) => setDeleteEmail(event.target.value)}
            placeholder="예: admin@urotech.co.kr"
            disabled={readOnly}
            className="flex-1 min-w-[220px] px-3 py-2.5 rounded-lg border border-slate-300 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-50"
          />
          <button
            type="submit"
            disabled={readOnly || busy === 'email' || deleteEmail === savedDeleteEmail}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-bold"
          >
            {busy === 'email' ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Mail className="w-3.5 h-3.5" />
            )}
            <span>저장</span>
          </button>
        </form>
      </div>
    </div>
  );
};
