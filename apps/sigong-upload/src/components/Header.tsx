import React from 'react';
import {
  AlertTriangle,
  Building2,
  FolderTree,
  HardHat,
  LogOut,
  ScrollText,
  ShieldCheck,
} from 'lucide-react';
import type { AdminSession, PublicConfig } from '../types';

export type AppView =
  | 'register'
  | 'completed'
  | 'admin-login'
  | 'admin-sites'
  | 'admin-detail'
  | 'admin-logs'
  | 'admin-issues'
  | 'admin-accounts';

interface HeaderProps {
  currentView: AppView;
  session: AdminSession | null;
  config: PublicConfig | null;
  onNavigate: (view: AppView) => void;
  onOpenDiagnostics: () => void;
  onLogout: () => void;
}

interface AdminTab {
  view: AppView;
  label: string;
  Icon: typeof ShieldCheck;
  /** Account management is master-only, so the tab is hidden for others. */
  masterOnly?: boolean;
}

const ADMIN_TABS: AdminTab[] = [
  { view: 'admin-sites', label: '현장 목록', Icon: HardHat },
  { view: 'admin-logs', label: '업로드 로그', Icon: ScrollText },
  { view: 'admin-issues', label: '이슈 관리', Icon: AlertTriangle },
  { view: 'admin-accounts', label: '계정 관리', Icon: ShieldCheck, masterOnly: true },
];

export const Header: React.FC<HeaderProps> = ({
  currentView,
  session,
  config,
  onNavigate,
  onOpenDiagnostics,
  onLogout,
}) => {
  const isAdminView = currentView.startsWith('admin-') && currentView !== 'admin-login';

  return (
    <header id="main-header" className="sticky top-0 z-30 bg-white border-b border-slate-200 shadow-xs">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16 gap-3">
          {/* Identity */}
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-lg bg-blue-600 flex items-center justify-center text-white shadow-xs shrink-0">
              <Building2 className="w-6 h-6" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="text-base sm:text-lg font-bold text-slate-900 leading-tight truncate">
                  시공현장 자료 수집·관리 시스템
                </h1>
                <span
                  className={`hidden sm:inline text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${
                    isAdminView
                      ? 'bg-purple-100 text-purple-700 border border-purple-200'
                      : 'bg-emerald-100 text-emerald-700 border border-emerald-200'
                  }`}
                >
                  {isAdminView ? '관리자 모드' : '현장 공유 링크'}
                </span>
              </div>
              <p className="text-xs text-slate-500 hidden md:block truncate">
                {isAdminView
                  ? `${session?.displayName ?? '관리자'}${session?.role === 'MASTER' ? ' (마스터)' : ''} — 제출 자료 확인 및 저장소 관리`
                  : '외부 작업자용 로그인 없는 현장자료 즉시 제출 페이지'}
              </p>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 shrink-0">
            {isAdminView ? (
              <>
                <button
                  type="button"
                  onClick={onOpenDiagnostics}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 transition-colors"
                  title="저장소 연동 상태 및 폴더 구조 확인"
                >
                  <FolderTree className="w-3.5 h-3.5 text-blue-600" />
                  <span className="hidden lg:inline">저장소 상태</span>
                </button>
                <button
                  type="button"
                  onClick={() => onNavigate('register')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white transition-colors shadow-xs"
                >
                  <HardHat className="w-4 h-4" />
                  <span className="hidden sm:inline">등록 화면</span>
                </button>
                <button
                  type="button"
                  onClick={onLogout}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-semibold border border-slate-300 hover:bg-slate-50 text-slate-600 transition-colors"
                  title="로그아웃"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span className="hidden lg:inline">로그아웃</span>
                </button>
              </>
            ) : (
              <>
                {config && (
                  <span className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium bg-slate-100 text-slate-600 border border-slate-300">
                    <FolderTree className="w-3.5 h-3.5 text-blue-600" />
                    {config.mode === 'LIVE' ? '클라우드 저장 연동됨' : '테스트 저장 모드'}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => onNavigate('admin-sites')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs sm:text-sm font-semibold bg-slate-800 hover:bg-slate-900 text-white transition-colors shadow-xs"
                >
                  <ShieldCheck className="w-4 h-4 text-purple-300" />
                  <span>관리자</span>
                </button>
              </>
            )}
          </div>
        </div>

        {/* Admin section tabs */}
        {isAdminView && (
          <nav className="flex items-center gap-1 -mb-px overflow-x-auto">
            {ADMIN_TABS.filter((tab) => !tab.masterOnly || session?.role === 'MASTER').map(({ view, label, Icon }) => {
              // The detail page belongs to the sites tab.
              const active =
                currentView === view || (view === 'admin-sites' && currentView === 'admin-detail');
              return (
                <button
                  key={view}
                  type="button"
                  onClick={() => onNavigate(view)}
                  className={`inline-flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-semibold border-b-2 transition-colors whitespace-nowrap ${
                    active
                      ? 'border-blue-600 text-blue-700'
                      : 'border-transparent text-slate-500 hover:text-slate-800'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {label}
                </button>
              );
            })}
          </nav>
        )}
      </div>
    </header>
  );
};
