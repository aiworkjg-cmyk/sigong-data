import React from 'react';
import { Building2, ShieldCheck, ExternalLink, HardHat, RefreshCw, FolderTree } from 'lucide-react';
import { SharePointConfigStatus } from '../types';

interface HeaderProps {
  currentView: 'register' | 'completed' | 'admin-list' | 'admin-detail';
  onNavigate: (view: 'register' | 'admin-list') => void;
  sharePointStatus: SharePointConfigStatus | null;
  onOpenSharePointInspector: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  currentView,
  onNavigate,
  sharePointStatus,
  onOpenSharePointInspector,
}) => {
  const isAdmin = currentView === 'admin-list' || currentView === 'admin-detail';

  return (
    <header id="main-header" className="sticky top-0 z-30 bg-white border-b border-slate-200 shadow-xs">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo & Title */}
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-blue-600 flex items-center justify-center text-white shadow-xs">
              <Building2 className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base sm:text-lg font-bold text-slate-900 leading-tight">
                  시공현장 자료 수집·관리 시스템
                </h1>
                <span
                  id="view-badge"
                  className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    isAdmin
                      ? 'bg-purple-100 text-purple-700 border border-purple-200'
                      : 'bg-emerald-100 text-emerald-700 border border-emerald-200'
                  }`}
                >
                  {isAdmin ? '관리자 모드' : '현장 공유 링크'}
                </span>
              </div>
              <p className="text-xs text-slate-500 hidden sm:block">
                {isAdmin
                  ? '현장별 제출 자료 확인 및 Microsoft SharePoint 저장 관리'
                  : '외부 작업자용 로그인 없는 현장자료 즉시 제출 페이지'}
              </p>
            </div>
          </div>

          {/* Right Action buttons */}
          <div className="flex items-center gap-2 sm:gap-3">
            {/* SharePoint status badge & folder preview button */}
            <button
              id="btn-sharepoint-status"
              onClick={onOpenSharePointInspector}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors border border-slate-300"
              title="SharePoint 저장 구조 및 연동 상태 확인"
            >
              <FolderTree className="w-3.5 h-3.5 text-blue-600" />
              <span className="hidden md:inline">SharePoint 저장소:</span>
              <span className="font-semibold text-blue-700">
                {sharePointStatus?.mode === 'LIVE' ? '실제 연동' : '테스트 저장'}
              </span>
            </button>

            {/* Navigation Mode Switcher */}
            {isAdmin ? (
              <button
                id="btn-switch-to-register"
                onClick={() => onNavigate('register')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs sm:text-sm font-semibold bg-emerald-600 hover:bg-emerald-700 text-white transition-colors shadow-xs"
              >
                <HardHat className="w-4 h-4" />
                <span>현장 등록 링크 열기</span>
              </button>
            ) : (
              <button
                id="btn-switch-to-admin"
                onClick={() => onNavigate('admin-list')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs sm:text-sm font-semibold bg-slate-800 hover:bg-slate-900 text-white transition-colors shadow-xs"
              >
                <ShieldCheck className="w-4 h-4 text-purple-300" />
                <span>관리자 화면</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};
