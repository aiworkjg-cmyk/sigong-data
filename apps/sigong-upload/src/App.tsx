import React, { useCallback, useEffect, useState } from 'react';
import { ApiError, adminApi, publicApi, type PublicStatus } from './api';
import type { AdminSession, SiteFile, SiteRecord, UploadProgressItem } from './types';
import { Header, type AppView } from './components/Header';
import { ExternalSubmissionForm } from './components/ExternalSubmissionForm';
import { UploadProgressModal } from './components/UploadProgressModal';
import { SubmissionSuccessView } from './components/SubmissionSuccessView';
import { AdminLogin } from './components/AdminLogin';
import { AdminSiteList } from './components/AdminSiteList';
import { AdminSiteDetail } from './components/AdminSiteDetail';
import { AdminUploadLogs } from './components/AdminUploadLogs';
import { AdminIssues } from './components/AdminIssues';
import { MediaViewerModal } from './components/MediaViewerModal';
import { AdminDiagnosticsModal } from './components/AdminDiagnosticsModal';

export default function App() {
  const [currentView, setCurrentView] = useState<AppView>('register');
  const [status, setStatus] = useState<PublicStatus | null>(null);

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

  // Modals
  const [previewFile, setPreviewFile] = useState<SiteFile | null>(null);
  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = useState(false);

  /* ---------------------------------------------------------------- */
  /* Bootstrap                                                         */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    publicApi.status().then(setStatus).catch(() => setStatus(null));

    // Restore an existing admin session so a refresh does not force a re-login.
    adminApi
      .session()
      .then(({ session: restored }) => setSession(restored))
      .catch(() => setSession(null))
      .finally(() => setIsCheckingSession(false));
  }, []);

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

  // Any admin view needs the site list; fetch it once the session is known.
  useEffect(() => {
    if (session && currentView.startsWith('admin-') && currentView !== 'admin-login') {
      void fetchSites();
    }
  }, [session, currentView, fetchSites]);

  /* ---------------------------------------------------------------- */
  /* Navigation                                                        */
  /* ---------------------------------------------------------------- */

  const navigate = (view: AppView) => {
    // Admin destinations fall through to the login form until authenticated.
    if (view.startsWith('admin-') && view !== 'admin-login' && !session) {
      setCurrentView('admin-login');
      return;
    }
    setCurrentView(view);
  };

  const openSite = async (siteId: string) => {
    setSelectedSiteId(siteId);
    setCurrentView('admin-detail');

    // The list may be paged or stale; make sure the record is loaded.
    if (!sites.some((site) => site.id === siteId)) {
      try {
        const { site } = await adminApi.site(siteId);
        setSites((prev) => [site, ...prev.filter((candidate) => candidate.id !== site.id)]);
      } catch {
        setCurrentView('admin-sites');
      }
    }
  };

  const handleLogout = async () => {
    await adminApi.logout().catch(() => undefined);
    setSession(null);
    setSites([]);
    setSelectedSiteId(null);
    setCurrentView('register');
  };

  /* ---------------------------------------------------------------- */
  /* Submission                                                        */
  /* ---------------------------------------------------------------- */

  const handleSiteSubmit = (formData: {
    managerName: string;
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
    body.append('managerName', formData.managerName);
    body.append('address', formData.address);
    body.append('constructionDate', formData.constructionDate);
    body.append('notes', formData.notes);
    formData.files.forEach((file) => body.append('files', file));

    const xhr = new XMLHttpRequest();

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;

      // Transfer covers 5%–80%; the remainder is server-side cloud sync.
      const ratio = event.loaded / event.total;
      setOverallProgress(Math.round(5 + ratio * 75));
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
        setCurrentStage('서버 저장 및 클라우드 동기화 단계');
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
        setCurrentStage('3단계: 클라우드 폴더 분류 및 저장이 완료되었습니다.');
        setProgressItems((prev) => prev.map((item) => ({ ...item, progress: 100, status: 'completed' })));

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

  /* ---------------------------------------------------------------- */
  /* Render                                                            */
  /* ---------------------------------------------------------------- */

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 flex flex-col font-sans">
      <Header
        currentView={currentView}
        session={session}
        status={status}
        onNavigate={navigate}
        onOpenDiagnostics={() => setIsDiagnosticsOpen(true)}
        onLogout={() => void handleLogout()}
      />

      <main className="flex-1">
        {currentView === 'register' && (
          <ExternalSubmissionForm onSubmit={handleSiteSubmit} isSubmitting={isSubmitting} />
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
                setCurrentView('admin-sites');
              }}
              onCancel={() => setCurrentView('register')}
            />
          ))}

        {currentView === 'admin-sites' && session && (
          <AdminSiteList
            sites={sites}
            isLoading={isLoadingSites}
            onRefresh={() => void fetchSites()}
            onSelectSite={(siteId) => void openSite(siteId)}
            onGoToRegister={() => setCurrentView('register')}
          />
        )}

        {currentView === 'admin-detail' && session && selectedSite && (
          <AdminSiteDetail
            site={selectedSite}
            onBack={() => setCurrentView('admin-sites')}
            onSelectFileForPreview={setPreviewFile}
            onOpenSharePointInspector={() => setIsDiagnosticsOpen(true)}
            onRetrySync={handleRetrySync}
          />
        )}

        {currentView === 'admin-logs' && session && (
          <AdminUploadLogs onOpenSite={(siteId) => void openSite(siteId)} />
        )}

        {currentView === 'admin-issues' && session && (
          <AdminIssues
            defaultSiteId={selectedSiteId ?? undefined}
            onOpenSite={(siteId) => void openSite(siteId)}
          />
        )}
      </main>

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
