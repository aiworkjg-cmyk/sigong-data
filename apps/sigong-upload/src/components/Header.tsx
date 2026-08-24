import React from 'react';
import {
  Building2,
  FolderTree,
  LogIn,
  LogOut,
  Menu,
  Monitor,
  Smartphone,
} from 'lucide-react';
import { ROLE_LABELS, isMaster } from '../types';
import type { AdminSession, PublicConfig } from '../types';
import type { AppView } from './Sidebar';

interface HeaderProps {
  session: AdminSession | null;
  config: PublicConfig | null;
  onNavigate: (view: AppView) => void;
  onOpenDiagnostics: () => void;
  onLogout: () => void;
  /** Opens the navigation drawer on small screens. */
  onOpenMenu: () => void;
  isMobilePreview: boolean;
  onToggleMobilePreview: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  session,
  config,
  onNavigate,
  onOpenDiagnostics,
  onLogout,
  onOpenMenu,
  isMobilePreview,
  onToggleMobilePreview,
}) => (
  <header
    id="main-header"
    className="sticky top-0 z-30 bg-white border-b border-slate-200 shadow-xs"
  >
    <div className="px-3 sm:px-5">
      <div className="flex items-center justify-between h-14 sm:h-16 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {/* Drawer toggle — small screens only, where the sidebar is hidden. */}
          <button
            type="button"
            onClick={onOpenMenu}
            className="lg:hidden p-2 -ml-1 rounded-lg text-slate-600 hover:bg-slate-100"
            aria-label="메뉴 열기"
          >
            <Menu className="w-5 h-5" />
          </button>

          {/* Identity — doubles as the home link. */}
          <button
            type="button"
            onClick={() => onNavigate('register')}
            className="flex items-center gap-2.5 min-w-0 rounded-lg px-1 py-1 hover:bg-slate-50 transition-colors"
            title="홈으로 이동"
          >
            <span className="w-9 h-9 rounded-lg bg-blue-600 flex items-center justify-center text-white shadow-xs shrink-0">
              <Building2 className="w-5 h-5" />
            </span>
            <span className="text-base sm:text-lg font-bold text-slate-900 leading-tight truncate">
              시공현장 자료 관리
            </span>
          </button>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {/* Mobile preview — most submissions arrive from a phone, so the
              admin needs to see the phone layout without leaving the desk. */}
          {session && (
            <button
              type="button"
              onClick={onToggleMobilePreview}
              className={`hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-semibold border transition-colors ${
                isMobilePreview
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-slate-100 text-slate-700 border-slate-300 hover:bg-slate-200'
              }`}
              title={isMobilePreview ? '데스크톱 보기로 전환' : '모바일 화면으로 미리보기'}
            >
              {isMobilePreview ? (
                <Monitor className="w-3.5 h-3.5" />
              ) : (
                <Smartphone className="w-3.5 h-3.5" />
              )}
              <span className="hidden lg:inline">
                {isMobilePreview ? '데스크톱 보기' : '모바일 보기'}
              </span>
            </button>
          )}

          {isMaster(session?.role) && (
            <button
              type="button"
              onClick={onOpenDiagnostics}
              className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 transition-colors"
              title="저장소 연동 상태 및 폴더 구조 확인"
            >
              <FolderTree className="w-3.5 h-3.5 text-blue-600" />
              <span className="hidden lg:inline">저장소 상태</span>
            </button>
          )}

          {/* Storage mode is an operations detail — master only. Submitters and
              company accounts have nothing to do with which backend is live. */}
          {isMaster(session?.role) && config && (
            <span className="hidden md:inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium bg-slate-100 text-slate-600 border border-slate-300">
              <FolderTree className="w-3.5 h-3.5 text-blue-600" />
              {config.mode === 'LIVE' ? '클라우드 저장 연동됨' : '테스트 저장 모드'}
            </span>
          )}

          {session ? (
            <>
              <span className="hidden sm:flex flex-col items-end leading-tight px-1">
                <span className="text-xs font-bold text-slate-800 truncate max-w-[10rem]">
                  {session.displayName}
                </span>
                <span className="text-[11px] text-slate-500">{ROLE_LABELS[session.role]}</span>
              </span>
              <button
                type="button"
                onClick={onLogout}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-semibold border border-slate-300 hover:bg-slate-50 text-slate-600 transition-colors"
                title="로그아웃"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">로그아웃</span>
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => onNavigate('admin-login')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs sm:text-sm font-semibold bg-slate-800 hover:bg-slate-900 text-white transition-colors shadow-xs"
            >
              <LogIn className="w-4 h-4" />
              <span>로그인</span>
            </button>
          )}
        </div>
      </div>
    </div>
  </header>
);
