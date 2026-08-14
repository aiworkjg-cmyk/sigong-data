import React, { useState, useEffect } from 'react';
import { SiteRecord, SiteFile, UploadProgressItem, SharePointConfigStatus } from './types';
import { Header } from './components/Header';
import { ExternalSubmissionForm } from './components/ExternalSubmissionForm';
import { UploadProgressModal } from './components/UploadProgressModal';
import { SubmissionSuccessView } from './components/SubmissionSuccessView';
import { AdminSiteList } from './components/AdminSiteList';
import { AdminSiteDetail } from './components/AdminSiteDetail';
import { MediaViewerModal } from './components/MediaViewerModal';
import { SharePointInspectorModal } from './components/SharePointInspectorModal';

export default function App() {
  // Views: 'register' (외부 등록), 'completed' (제출 완료), 'admin-list' (관리자 현장목록), 'admin-detail' (현장 상세)
  const [currentView, setCurrentView] = useState<'register' | 'completed' | 'admin-list' | 'admin-detail'>('register');
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null);
  const [submittedSite, setSubmittedSite] = useState<SiteRecord | null>(null);

  // Sites list for Admin
  const [sites, setSites] = useState<SiteRecord[]>([]);
  const [isLoadingSites, setIsLoadingSites] = useState(false);

  // Upload Progress Modal state
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showProgressModal, setShowProgressModal] = useState(false);
  const [overallProgress, setOverallProgress] = useState(0);
  const [progressItems, setProgressItems] = useState<UploadProgressItem[]>([]);
  const [currentStage, setCurrentStage] = useState('');
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Modals
  const [previewMediaFile, setPreviewMediaFile] = useState<SiteFile | null>(null);
  const [isSharePointInspectorOpen, setIsSharePointInspectorOpen] = useState(false);
  const [sharePointStatus, setSharePointStatus] = useState<SharePointConfigStatus | null>(null);

  // Fetch SharePoint Status on mount
  const fetchSharePointStatus = async () => {
    try {
      const res = await fetch('/api/sharepoint/status');
      if (res.ok) {
        const data = await res.json();
        setSharePointStatus(data);
      }
    } catch (err) {
      console.error('SharePoint status check error:', err);
    }
  };

  // Fetch all sites list
  const fetchSites = async () => {
    setIsLoadingSites(true);
    try {
      const res = await fetch('/api/sites');
      if (res.ok) {
        const data = await res.json();
        setSites(data.sites || []);
      }
    } catch (err) {
      console.error('Error fetching sites:', err);
    } finally {
      setIsLoadingSites(false);
    }
  };

  useEffect(() => {
    fetchSharePointStatus();
    fetchSites();
  }, []);

  // Handle Form Submission with real XMLHttpRequest progress tracking
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
    setCurrentStage('1단계: 제출 파일 및 현장 정보 유효성 검증 중...');

    // Initialize progress items
    const initialProgressItems: UploadProgressItem[] = formData.files.map((file, idx) => ({
      fileId: `file-${idx}`,
      fileName: file.name,
      fileSize: file.size,
      progress: 0,
      status: 'pending',
    }));
    setProgressItems(initialProgressItems);

    const xhr = new XMLHttpRequest();
    const data = new FormData();

    data.append('managerName', formData.managerName);
    data.append('address', formData.address);
    data.append('constructionDate', formData.constructionDate);
    data.append('notes', formData.notes);

    formData.files.forEach((file) => {
      data.append('files', file);
    });

    // Upload progress handler
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        // Compute 5% to 80% based on upload bytes
        const percent = Math.round(5 + (event.loaded / event.total) * 75);
        setOverallProgress(percent);
        setCurrentStage(`2단계: 파일 전송 중 (${(event.loaded / (1024 * 1024)).toFixed(1)}MB / ${(event.total / (1024 * 1024)).toFixed(1)}MB)...`);

        // Update progress items
        const currentProgressRatio = event.loaded / event.total;
        setProgressItems((prev) =>
          prev.map((item, idx) => {
            const itemThreshold = (idx + 1) / prev.length;
            if (currentProgressRatio >= itemThreshold) {
              return { ...item, progress: 100, status: 'completed' };
            } else {
              return { ...item, progress: Math.min(Math.round(currentProgressRatio * 100 * (idx + 1)), 90), status: 'uploading' };
            }
          })
        );
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        setOverallProgress(90);
        setCurrentStage('3단계: Microsoft SharePoint 폴더 생성 및 현장정보 동기화 중...');

        try {
          const response = JSON.parse(xhr.responseText);
          const newSite: SiteRecord = response.site;

          setTimeout(() => {
            setOverallProgress(100);
            setCurrentStage('4단계: 모든 데이터와 파일 저장이 최종 완료되었습니다.');
            setProgressItems((prev) =>
              prev.map((item) => ({ ...item, progress: 100, status: 'completed' }))
            );

            // Finish after brief delay to show 100% completed
            setTimeout(() => {
              setIsSubmitting(false);
              setShowProgressModal(false);
              setSubmittedSite(newSite);
              setCurrentView('completed');
              fetchSites(); // refresh admin list
            }, 600);
          }, 500);
        } catch (err: any) {
          setIsSubmitting(false);
          setCurrentStage('응답 처리 단계');
          setUploadError('서버 응답 파싱 중 오류가 발생했습니다.');
        }
      } else {
        setIsSubmitting(false);
        let errorMsg = '현장자료 저장에 실패했습니다.';
        try {
          const errRes = JSON.parse(xhr.responseText);
          errorMsg = errRes.message || errRes.error || errorMsg;
        } catch (e) {
          errorMsg = `서버 오류 (${xhr.status}): ${xhr.statusText}`;
        }
        setCurrentStage('서버 저장 및 SharePoint 동기화 단계');
        setUploadError(errorMsg);
        setProgressItems((prev) =>
          prev.map((item) => (item.status !== 'completed' ? { ...item, status: 'failed', error: errorMsg } : item))
        );
      }
    };

    xhr.onerror = () => {
      setIsSubmitting(false);
      setCurrentStage('네트워크 통신 단계');
      setUploadError('네트워크 연결 오류가 발생했습니다. 인터넷 연결을 확인한 후 다시 시도해 주십시오.');
      setProgressItems((prev) =>
        prev.map((item) => (item.status !== 'completed' ? { ...item, status: 'failed' } : item))
      );
    };

    xhr.open('POST', '/api/sites', true);
    xhr.send(data);
  };

  // Retry SharePoint Sync for Admin
  const handleRetrySync = async (siteId: string) => {
    try {
      const res = await fetch(`/api/sites/${siteId}/retry-sharepoint`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setSites((prev) => prev.map((s) => (s.id === siteId ? data.site : s)));
        if (selectedSiteId === siteId) {
          // updated
        }
      }
    } catch (e) {
      console.error('Error retrying SharePoint sync:', e);
    }
  };

  // Selected site for detail view
  const selectedSite = sites.find((s) => s.id === selectedSiteId) || submittedSite;

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 flex flex-col font-sans">
      {/* Top Header */}
      <Header
        currentView={currentView}
        onNavigate={(view) => {
          if (view === 'register') {
            setCurrentView('register');
          } else if (view === 'admin-list') {
            setCurrentView('admin-list');
            fetchSites();
          }
        }}
        sharePointStatus={sharePointStatus}
        onOpenSharePointInspector={() => setIsSharePointInspectorOpen(true)}
      />

      {/* Main Content Area based on current view */}
      <main className="flex-1">
        {currentView === 'register' && (
          <ExternalSubmissionForm
            onSubmit={handleSiteSubmit}
            isSubmitting={isSubmitting}
          />
        )}

        {currentView === 'completed' && submittedSite && (
          <SubmissionSuccessView
            site={submittedSite}
            onNewSubmission={() => {
              setSubmittedSite(null);
              setCurrentView('register');
            }}
            onGoToAdminDetail={(siteId) => {
              setSelectedSiteId(siteId);
              setCurrentView('admin-detail');
            }}
          />
        )}

        {currentView === 'admin-list' && (
          <AdminSiteList
            sites={sites}
            isLoading={isLoadingSites}
            onRefresh={fetchSites}
            onSelectSite={(siteId) => {
              setSelectedSiteId(siteId);
              setCurrentView('admin-detail');
            }}
            onGoToRegister={() => setCurrentView('register')}
          />
        )}

        {currentView === 'admin-detail' && selectedSite && (
          <AdminSiteDetail
            site={selectedSite}
            onBack={() => setCurrentView('admin-list')}
            onSelectFileForPreview={(file) => setPreviewMediaFile(file)}
            onOpenSharePointInspector={() => setIsSharePointInspectorOpen(true)}
            onRetrySync={handleRetrySync}
          />
        )}
      </main>

      {/* Upload Progress & Error Modal */}
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

      {/* Full Media Preview Modal (Image & Video) */}
      <MediaViewerModal
        file={previewMediaFile}
        onClose={() => setPreviewMediaFile(null)}
      />

      {/* SharePoint Folder Hierarchy Inspector Modal */}
      <SharePointInspectorModal
        isOpen={isSharePointInspectorOpen}
        onClose={() => setIsSharePointInspectorOpen(false)}
        status={sharePointStatus}
      />
    </div>
  );
}
