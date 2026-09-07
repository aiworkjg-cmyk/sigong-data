import React from 'react';
import {
  AlertTriangle,
  ClipboardList,
  HardHat,
  Lock,
  ScrollText,
  Settings,
  Tags,
  ShieldCheck,
  Upload,
  UserCog,
  Users,
  CalendarDays,
} from 'lucide-react';
import { canManageTechnicians, isMaster } from '../types';
import type { AdminSession } from '../types';

export type AppView =
  | 'register'
  | 'completed'
  | 'history'
  | 'technicians'
  | 'technician-roster'
  | 'construction-types'
  | 'admin-login'
  | 'admin-sites'
  | 'work-orders'
  | 'calendar'
  | 'admin-detail'
  | 'admin-logs'
  | 'admin-issues'
  | 'admin-settings'
  | 'admin-accounts';

interface NavItem {
  view: AppView;
  label: string;
  Icon: typeof Upload;
  /** Shown to signed-out visitors with a lock, rather than hidden entirely. */
  requiresLogin?: boolean;
  visible?: (session: AdminSession | null) => boolean;
}

/**
 * The two entries every visitor sees. 시공현장 자료 제출 is the landing page and
 * needs no account; 시공현황 리스트 is shown to everyone but locked until sign-in,
 * so a field worker can see that the feature exists and ask for a login.
 */
const PRIMARY_ITEMS: NavItem[] = [
  { view: 'register', label: '시공현장 자료 제출', Icon: Upload },
  { view: 'history', label: '시공현황 리스트', Icon: ClipboardList, requiresLogin: true },
];

/** Roster management — 마스터 and 업체 관리자; 시공종류 is master-only. */
const MANAGER_ITEMS: NavItem[] = [
  {
    view: 'work-orders',
    label: '주문서 등록 · 연동',
    Icon: ClipboardList,
    visible: (session) => canManageTechnicians(session?.role),
  },
  {
    view: 'calendar',
    label: '시공건 관리',
    Icon: CalendarDays,
    visible: (session) => canManageTechnicians(session?.role),
  },
  {
    // 시공종류와 그 종류에 딸린 입력 항목. 기사 명부는 따로 뺐습니다 —
    // 기사는 자주 들고 나는 데다 이 화면은 종류를 정하는 곳이라, 한데 두면
    // 기사 한 명 추가하려고 종류 설정 화면을 지나야 했습니다.
    view: 'technicians',
    label: '시공종류별 현장',
    Icon: Users,
    visible: (session) => canManageTechnicians(session?.role),
  },
  {
    view: 'technician-roster',
    label: '시공기사 관리',
    Icon: UserCog,
    visible: (session) => canManageTechnicians(session?.role),
  },
];

/** The full console. Master only — nobody else ever sees these. */
const MASTER_ITEMS: NavItem[] = [
  { view: 'admin-sites', label: '현장 목록', Icon: HardHat },
  { view: 'admin-logs', label: '업로드 로그', Icon: ScrollText },
  { view: 'admin-issues', label: '이슈 관리', Icon: AlertTriangle },
  { view: 'admin-settings', label: '설정', Icon: Settings },
  { view: 'admin-accounts', label: '계정 관리', Icon: ShieldCheck },
];

interface SidebarProps {
  currentView: AppView;
  session: AdminSession | null;
  onNavigate: (view: AppView) => void;
  /** Closes the drawer after a tap on mobile. */
  onNavigated?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentView,
  session,
  onNavigate,
  onNavigated,
}) => {
  const go = (view: AppView) => {
    onNavigate(view);
    onNavigated?.();
  };

  const renderItem = ({ view, label, Icon, requiresLogin }: NavItem) => {
    // The detail page belongs to whichever list the viewer reached it from.
    const active =
      currentView === view ||
      (view === 'admin-sites' && currentView === 'admin-detail' && isMaster(session?.role)) ||
      (view === 'history' && currentView === 'admin-detail' && !isMaster(session?.role));
    const locked = requiresLogin && !session;

    return (
      <button
        key={view}
        type="button"
        onClick={() => go(view)}
        className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-semibold transition-colors text-left ${
          active
            ? 'bg-blue-50 text-blue-800 border border-blue-200'
            : 'text-slate-600 hover:bg-slate-100 border border-transparent'
        }`}
      >
        <Icon className={`w-4 h-4 shrink-0 ${active ? 'text-blue-600' : 'text-slate-400'}`} />
        <span className="flex-1 truncate">{label}</span>
        {locked && <Lock className="w-3.5 h-3.5 text-slate-300 shrink-0" />}
      </button>
    );
  };

  const managerItems = MANAGER_ITEMS.filter((item) => item.visible?.(session));
  const showMaster = isMaster(session?.role);

  return (
    <nav className="p-3 space-y-1" aria-label="주요 메뉴">
      {PRIMARY_ITEMS.map(renderItem)}

      {managerItems.length > 0 && (
        <>
          <SectionLabel>관리</SectionLabel>
          {managerItems.map(renderItem)}
        </>
      )}

      {showMaster && (
        <>
          <SectionLabel>마스터 전용</SectionLabel>
          {MASTER_ITEMS.map(renderItem)}
        </>
      )}
    </nav>
  );
};

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="px-3 pt-4 pb-1 text-[11px] font-bold text-slate-400 uppercase tracking-wide">
    {children}
  </p>
);
