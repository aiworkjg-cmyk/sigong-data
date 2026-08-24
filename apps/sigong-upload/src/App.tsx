import React, { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { ApiError, adminApi, publicApi } from './api';
import { isMaster } from './types';
import type { AdminSession, PublicConfig, SiteFile, SiteRecord, UploadProgressItem } from './types';
import { Header } from './components/Header';
import { Sidebar, type AppView } from './components/Sidebar';
import { ExternalSubmissionForm } from './components/ExternalSubmissionForm';
import { UploadProgressModal } from './components/UploadProgressModal';
import { SubmissionSuccessView } from './components/SubmissionSuccessView';
import { AdminLogin } from './components/AdminLogin';
import { SiteHistory } from './components/SiteHistory';
import { TechnicianManager } from './components/TechnicianManager';
import { ConstructionTypeManager } from './components/ConstructionTypeManager';
import { AdminSiteList } from './components/AdminSiteList';
import { AdminSiteDetail } from './components/AdminSiteDetail';
import { AdminUploadLogs } from './components/AdminUploadLogs';
import { AdminIssues } from './components/AdminIssues';
import { AdminAccounts } from './components/AdminAccounts';
import { AdminSettings } from './components/AdminSettings';
import { MediaViewerModal } from './components/MediaViewerModal';
import { AdminDiagnosticsModal } from './components/AdminDiagnosticsModal';

/** Views only the master may open. Anyone else is bounced to 시공현황 리스트. */
const MASTER_ONLY: AppView[] = [
  'construction-types',
  'admin-sites',
  'admin-logs',
  'admin-issues',
  'admin-settings',
  'admin-accounts',
];

export default function App() {
  const [currentView, setCurrentView] = useState<AppView>('register');
  const [publicConfig, setPublicConfig] = useState<PublicConfig | null>(null);

  // Admin state
  const [session, setSession] = useState<AdminSession | null>(null);
  const [isCheckingSession, setIsCheckingSession] = useState(true);
  const [sites, setSites] = useState<SiteRecord[]>([]);
  const [isLoadingSites, setIsLoadingSites] = useState(false);
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null);

  // Submission state
  const [submittedSite, setSubmittedSite] = useState<SiteRecord | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showProgressModal, setShowProgressModal] = useState(false);
  const [overallProgress, setOverallProgress] = useState(0);
  const [progressItems, setProgressItems] = useState<UploadProgressItem[]>([]);
  const [currentStage, setCurrentStage] = useState('');
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Shell
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isMobilePreview, setIsMobilePreview] = useState(false);
  const [previewFile, setPreviewFile] = useState<SiteFile | null>(null);
  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = useState(false);

  /* ---------------------------------------------------------------- */
  /* Bootstrap                                                         */
  /* ---------------------------------------------------------------- */

  const loadPublicConfig = useCallback(() => {
    publicApi
      .config()
      .then(setPublicConfig)
      .catch(() => setPublicConfig(null));
  }, []);

  useEffect(() => {
    loadPublicConfig();

    // Restore an existing session so a refresh does not force a re-login.
    adminApi
      .session()
      .then(({ session: restored }) => setSession(restored))
      .catch(() => setSession(null))
      .finally(() => setIsCheckingSession(false));
  }, [loadPublicConfig]);

  // Only the master console needs the full site list.
  const fetchSites = useCallback(async () => {
    setIsLoadingSites(true);
    try {
      const page = await adminApi.sites({ limit: 100 });
      setSites(page.items);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setSession(null);
        setCurrentView('admin-login');
      }
    } finally {
      setIsLoadingSites(false);
    }
  }, []);

  useEffect(() => {
    if (isMaster(session?.role) && (currentView === 'admin-sites' || currentView === 'admin-logs')) {
      void fetchSites();
    }
  }, [session, currentView, fetchSites]);

  // A session that loses its privileges must not be left staring at a blank
  // master screen.
  useEffect(() => {
    if (MASTER_ONLY.includes(currentView) && !isMaster(session?.role)) {
      setCurrentView(session ? 'history' : 'register');
    }
  }, [session, currentView]);

  /* ---------------------------------------------------------------- */
  /* Navigation                                                        */
  /* ---------------------------------------------------------------- */

  const navigate = (view: AppView) => {
    // Anything behind a login falls through to the login form.
    const needsLogin = view !== 'register' && view !== 'completed' && view !== 'admin-login';
    if (needsLogin && !session) {
      setCurrentView('admin-login');
      return;
    }
    if (MASTER_ONLY.includes(view) && !isMaster(session?.role)) {
      setCurrentView('history');
      return;
    }
    setCurrentView(view);
  };

  const openSite = async (siteId: string) => {
    setSelectedSiteId(siteId);
    setCurrentView('admin-detail');

    if (!sites.some((site) => site.id === siteId)) {
      try {
        const { site } = await adminApi.site(siteId);
        setSites((prev) => [site, ...prev.filter((candidate) => candidate.id !== site.id)]);
      } catch {
        setCurrentView(isMaster(session?.role) ? 'admin-sites' : 'history');
      }
    }
  };

  const handleLogout = async () => {
    await adminApi.logout().catch(() => undefined);
    setSession(null);
    setSites([]);
    setSelectedSiteId(null);
    setIsMobilePreview(false);
    setCurrentView('register');
  };

  /* ---------------------------------------------------------------- */
  /* Submission                                                        */
  /* ---------------------------------------------------------------- */

  const handleSiteSubmit = (formData: {
    constructionType: string;
    technicianIds: string[];
    address: string;
    constructionDate: string;
    notes: string;
    files: File[];
  }) => {
    setIsSubmitting(true);
    setShowProgressModal(true);
    setUploadError(null);
    setOverallProgress(5);
    setCurrentStage('1단계: 제출 파일 및 현장 정보 확인 중...');
    setProgressItems(
      formData.files.map((file, index) => ({
        fileId: `file-${index}`,
        fileName: file.name,
        fileSize: file.size,
        progress: 0,
        status: 'pending',
      }))
    );

    const body = new FormData();
    body.append('constructionType', formData.constructionType);
    formData.technicianIds.forEach((id) => body.append('technicianIds', id));
    body.append('address', formData.address);
    body.append('constructionDate', formData.constructionDate);
    body.append('notes', formData.notes);
    formData.files.forEach((file) => body.append('files', file));

    const xhr = new XMLHttpRequest();

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;

      // The transfer is the whole wait now: filing into the library happens
      // after the response, so progress can run to completion here.
      const ratio = event.loaded / event.total;
      setOverallProgress(Math.round(5 + ratio * 90));
      setCurrentStage(
        `2단계: 파일 전송 중 (${(event.loaded / 1048576).toFixed(1)}MB / ${(event.total / 1048576).toFixed(1)}MB)...`
      );

      setProgressItems((prev) => {
        // Approximate per-file progress from the aggregate byte counter, which
        // is all XHR exposes for a multipart body.
        const completedCount = Math.floor(ratio * prev.length);
        return prev.map((item, index) => {
          if (index < completedCount) return { ...item, progress: 100, status: 'completed' };
          if (index === completedCount) {
            return {
              ...item,
              progress: Math.round((ratio * prev.length - completedCount) * 100),
              status: 'uploading',
            };
          }
          return item;
        });
      });
    };

    xhr.onload = () => {
      setIsSubmitting(false);

      if (xhr.status < 200 || xhr.status >= 300) {
        let message = '현장자료 저장에 실패했습니다.';
        try {
          const parsed = JSON.parse(xhr.responseText);
          message = parsed.message || parsed.error || message;
        } catch {
          message = `서버 오류 (${xhr.status}): ${xhr.statusText}`;
        }
        setCurrentStage('서버 접수 단계');
        setUploadError(message);
        setProgressItems((prev) =>
          prev.map((item) =>
            item.status === 'completed' ? item : { ...item, status: 'failed', error: message }
          )
        );
        return;
      }

      try {
        const { site } = JSON.parse(xhr.responseText) as { site: SiteRecord };
        setOverallProgress(100);
        setCurrentStage('3단계: 제출이 접수되었습니다.');
        setProgressItems((prev) =>
          prev.map((item) => ({ ...item, progress: 100, status: 'completed' }))
        );

        // Brief pause so the completed state is actually visible.
        setTimeout(() => {
          setShowProgressModal(false);
          setSubmittedSite(site);
          setCurrentView('completed');
        }, 700);
      } catch {
        setCurrentStage('응답 처리 단계');
        setUploadError('서버 응답을 해석하지 못했습니다. 관리자에게 문의해 주세요.');
      }
    };

    xhr.onerror = () => {
      setIsSubmitting(false);
      setCurrentStage('네트워크 통신 단계');
      setUploadError('네트워크 연결 오류가 발생했습니다. 연결 상태를 확인한 후 다시 시도해 주세요.');
      setProgressItems((prev) =>
        prev.map((item) => (item.status === 'completed' ? item : { ...item, status: 'failed' }))
      );
    };

    xhr.open('POST', '/api/sites', true);
    xhr.send(body);
  };

  const handleRetrySync = async (siteId: string) => {
    try {
      const { site } = await adminApi.retrySite(siteId);
      setSites((prev) => prev.map((candidate) => (candidate.id === siteId ? site : candidate)));
    } catch (err) {
      console.error('재동기화 실패', err);
    }
  };

  const selectedSite = sites.find((site) => site.id === selectedSiteId) ?? null;
  const master = isMaster(session?.role);

  /* ---------------------------------------------------------------- */
  /* Render                                                            */
  /* ---------------------------------------------------------------- */

  const content = (
    <>
      {currentView === 'register' && (
        <ExternalSubmissionForm
          onSubmit={handleSiteSubmit}
          isSubmitting={isSubmitting}
          constructionTypes={publicConfig?.constructionTypes ?? []}
          technicians={publicConfig?.technicians ?? []}
        />
      )}

      {currentView === 'completed' && submittedSite && (
        <SubmissionSuccessView
          site={submittedSite}
          onNewSubmission={() => {
            setSubmittedSite(null);
            setCurrentView('register');
          }}
        />
      )}

      {currentView === 'admin-login' &&
        (isCheckingSession ? (
          <p className="py-24 text-center text-xs text-slate-400">확인 중...</p>
        ) : (
          <AdminLogin
            onAuthenticated={(authenticated) => {
              setSession(authenticated);
              setCurrentView(isMaster(authenticated.role) ? 'admin-sites' : 'history');
            }}
            onCancel={() => setCurrentView('register')}
          />
        ))}

      {currentView === 'history' && session && (
        <SiteHistory session={session} onOpenSite={(siteId) => void openSite(siteId)} />
      )}

      {currentView === 'technicians' && session && <TechnicianManager session={session} />}

      {currentView === 'construction-types' && master && (
        <ConstructionTypeManager onChanged={loadPublicConfig} />
      )}

      {currentView === 'admin-detail' && session && selectedSite && (
        <AdminSiteDetail
          site={selectedSite}
          onBack={() => setCurrentView(master ? 'admin-sites' : 'history')}
          onSelectFileForPreview={setPreviewFile}
          onOpenSharePointInspector={() => setIsDiagnosticsOpen(true)}
          onRetrySync={handleRetrySync}
          canEdit={master}
        />
      )}

      {currentView === 'admin-sites' && master && (
        <AdminSiteList
          sites={sites}
          isLoading={isLoadingSites}
          onRefresh={() => void fetchSites()}
          onSelectSite={(siteId) => void openSite(siteId)}
          onGoToRegister={() => setCurrentView('register')}
        />
      )}

      {currentView === 'admin-logs' && master && (
        <AdminUploadLogs onOpenSite={(siteId) => void openSite(siteId)} />
      )}

      {currentView === 'admin-issues' && master && (
        <AdminIssues
          defaultSiteId={selectedSiteId ?? undefined}
          onOpenSite={(siteId) => void openSite(siteId)}
          canEdit
        />
      )}

      {currentView === 'admin-settings' && master && (
        <AdminSettings role={session!.role} />
      )}

      {currentView === 'admin-accounts' && session && <AdminAccounts session={session} />}
    </>
  );

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 flex flex-col font-sans">
      <Header
        session={session}
        config={publicConfig}
        onNavigate={navigate}
        onOpenDiagnostics={() => setIsDiagnosticsOpen(true)}
        onLogout={() => void handleLogout()}
        onOpenMenu={() => setIsDrawerOpen(true)}
        isMobilePreview={isMobilePreview}
        onToggleMobilePreview={() => setIsMobilePreview((prev) => !prev)}
      />

      <div className="flex-1 flex min-h-0">
        {/* Sidebar — always present from lg up. */}
        <aside className="hidden lg:block w-60 shrink-0 border-r border-slate-200 bg-white">
          <div className="sticky top-16">
            <Sidebar currentView={currentView} session={session} onNavigate={navigate} />
          </div>
        </aside>

        {/* Drawer — the same nav on phones, where 90% of submissions come from. */}
        {isDrawerOpen && (
          <div className="lg:hidden fixed inset-0 z-40 flex">
            <div className="absolute inset-0 bg-black/50" onClick={() => setIsDrawerOpen(false)} />
            <div className="relative w-64 max-w-[80vw] bg-white shadow-xl overflow-y-auto">
              <div className="flex items-center justify-between px-4 h-14 border-b border-slate-200">
                <span className="text-sm font-bold text-slate-800">메뉴</span>
                <button
                  type="button"
                  onClick={() => setIsDrawerOpen(false)}
                  className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100"
                  aria-label="메뉴 닫기"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <Sidebar
                currentView={currentView}
                session={session}
                onNavigate={navigate}
                onNavigated={() => setIsDrawerOpen(false)}
              />
            </div>
          </div>
        )}

        <main className="flex-1 min-w-0">
          {isMobilePreview ? (
            // A real 390px viewport rather than a scaled screenshot, so the
            // same breakpoints the phone hits are the ones being previewed.
            <div className="py-6 px-4 flex flex-col items-center">
              <p className="mb-3 text-xs font-semibold text-slate-500">
                모바일 미리보기 · 390 × 780
              </p>
              <div className="w-[390px] h-[780px] max-w-full rounded-[2rem] border-8 border-slate-800 bg-slate-100 overflow-y-auto overflow-x-hidden shadow-2xl">
                {content}
              </div>
            </div>
          ) : (
            content
          )}
        </main>
      </div>

      <UploadProgressModal
        isOpen={showProgressModal}
        overallProgress={overallProgress}
        progressItems={progressItems}
        currentStage={currentStage}
        errorMessage={uploadError}
        onCloseError={() => {
          setShowProgressModal(false);
          setUploadError(null);
        }}
      />

      {selectedSite && (
        <MediaViewerModal
          siteId={selectedSite.id}
          file={previewFile}
          onClose={() => setPreviewFile(null)}
        />
      )}

      <AdminDiagnosticsModal
        isOpen={isDiagnosticsOpen}
        onClose={() => setIsDiagnosticsOpen(false)}
      />
    </div>
  );
}
