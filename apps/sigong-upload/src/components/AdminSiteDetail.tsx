import React, { useState } from 'react';
import {
  ArrowLeft,
  Calendar,
  User,
  MapPin,
  FileText,
  FolderCheck,
  Image as ImageIcon,
  Video as VideoIcon,
  Download,
  Eye,
  ExternalLink,
  Copy,
  Check,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  HardDrive,
  FolderTree,
  Filter
} from 'lucide-react';
import { SiteRecord, SiteFile } from '../types';
import { fileContentUrl } from '../api';
import { statusMeta } from '../status';

interface AdminSiteDetailProps {
  site: SiteRecord;
  onBack: () => void;
  onSelectFileForPreview: (file: SiteFile) => void;
  onOpenSharePointInspector: () => void;
  onRetrySync: (siteId: string) => Promise<void>;
}

export const AdminSiteDetail: React.FC<AdminSiteDetailProps> = ({
  site,
  onBack,
  onSelectFileForPreview,
  onOpenSharePointInspector,
  onRetrySync,
}) => {
  const [mediaFilter, setMediaFilter] = useState<'all' | 'image' | 'video'>('all');
  const [copiedId, setCopiedId] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);

  const handleCopyId = () => {
    navigator.clipboard.writeText(site.id);
    setCopiedId(true);
    setTimeout(() => setCopiedId(false), 2000);
  };

  const handleCopyPath = () => {
    navigator.clipboard.writeText(site.folderPath);
    setCopiedPath(true);
    setTimeout(() => setCopiedPath(false), 2000);
  };

  const handleRetry = async () => {
    setIsRetrying(true);
    try {
      await onRetrySync(site.id);
    } finally {
      setIsRetrying(false);
    }
  };

  const filteredFiles = site.files.filter((f) => {
    if (mediaFilter === 'image') return f.fileType === 'image';
    if (mediaFilter === 'video') return f.fileType === 'video';
    return true;
  });

  const photoCount = site.files.filter((f) => f.fileType === 'image').length;
  const videoCount = site.files.filter((f) => f.fileType === 'video').length;

  return (
    <div className="max-w-7xl mx-auto py-6 sm:py-8 px-4 sm:px-6 lg:px-8">
      {/* Back Button & Top Actions */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs sm:text-sm font-semibold text-slate-700 transition-colors shadow-2xs"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>현장목록으로 돌아가기</span>
        </button>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onOpenSharePointInspector}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 text-xs font-semibold transition-colors"
          >
            <FolderTree className="w-3.5 h-3.5" />
            <span>SharePoint 폴더 구조 확인</span>
          </button>

          <button
            type="button"
            onClick={handleRetry}
            disabled={isRetrying}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold transition-colors shadow-2xs"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRetrying ? 'animate-spin text-blue-600' : ''}`} />
            <span>저장 재시도</span>
          </button>
        </div>
      </div>

      {/* Main Info Card */}
      <div className="bg-white rounded-2xl border border-slate-200 p-6 sm:p-7 shadow-xs mb-8">
        {/* Title & Status */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-5 border-b border-slate-100 gap-3">
          <div>
            <div className="flex items-center gap-2.5 flex-wrap">
              <h2 className="text-xl sm:text-2xl font-extrabold text-slate-900">
                {site.address}
              </h2>
              <span
                className={`px-2.5 py-0.5 rounded-full text-xs font-bold border ${statusMeta(site.status).className}`}
              >
                {statusMeta(site.status).label}
              </span>
              <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200">
                {site.constructionType}
              </span>
              <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-600 border border-slate-200">
                {site.storageMode === 'LIVE' ? 'SharePoint 연동' : '테스트 저장'}
              </span>
            </div>
            <div className="flex items-center gap-2 mt-1.5 text-xs text-slate-500 font-mono">
              <span>현장 ID: <strong>{site.id}</strong></span>
              <button
                type="button"
                onClick={handleCopyId}
                className="hover:text-blue-600 transition-colors"
                title="ID 복사"
              >
                {copiedId ? <Check className="w-3.5 h-3.5 text-emerald-600 inline" /> : <Copy className="w-3.5 h-3.5 inline" />}
              </button>
            </div>
          </div>

          <div className="text-xs text-slate-500 sm:text-right">
            <span className="block">제출 등록일시</span>
            <span className="font-semibold text-slate-700">
              {new Date(site.createdAt).toLocaleString('ko-KR')}
            </span>
          </div>
        </div>

        {/* Info Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-5 text-sm">
          {/* 담당자 */}
          <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-100">
            <span className="text-xs text-slate-500 block mb-1 flex items-center gap-1">
              <User className="w-3.5 h-3.5 text-slate-400" /> 담당자 이름
            </span>
            <p className="font-bold text-slate-900">{site.managerName}</p>
          </div>

          {/* 시공일 */}
          <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-100">
            <span className="text-xs text-slate-500 block mb-1 flex items-center gap-1">
              <Calendar className="w-3.5 h-3.5 text-slate-400" /> 시공일 / 시공종류
            </span>
            <p className="font-bold text-slate-900">
              <span className="font-mono">{site.constructionDate}</span>
              <span className="text-slate-400 mx-1.5">·</span>
              {site.constructionType}
            </p>
          </div>

          {/* 총 첨부파일 */}
          <div className="bg-slate-50 p-3.5 rounded-xl border border-slate-100">
            <span className="text-xs text-slate-500 block mb-1 flex items-center gap-1">
              <FileText className="w-3.5 h-3.5 text-slate-400" /> 첨부 자료 현황
            </span>
            <p className="font-bold text-slate-900">
              총 {site.files.length}개 (사진 {photoCount}, 영상 {videoCount})
            </p>
          </div>

          {/* 특이사항 */}
          <div className="bg-slate-50 p-4 rounded-xl border border-slate-100 sm:col-span-3">
            <span className="text-xs text-slate-500 block mb-1.5 font-medium">특이사항 및 메모</span>
            <p className="text-slate-800 text-xs sm:text-sm whitespace-pre-wrap leading-relaxed">
              {site.notes || '등록된 특이사항이 없습니다.'}
            </p>
          </div>

          {/* SharePoint Sync Details */}
          <div className="bg-blue-50/70 p-4 rounded-xl border border-blue-200 sm:col-span-3">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
              <span className="text-xs font-bold text-blue-900 flex items-center gap-1.5">
                <FolderCheck className="w-4 h-4 text-blue-700" />
                Microsoft SharePoint 자동 생성 폴더 경로
              </span>
              <button
                type="button"
                onClick={handleCopyPath}
                className="text-xs text-blue-700 hover:text-blue-900 flex items-center gap-1 underline font-medium"
              >
                {copiedPath ? '복사됨' : '경로 복사'}
              </button>
            </div>
            <p className="font-mono text-xs text-blue-950 break-all bg-white/90 p-2.5 rounded-lg border border-blue-100">
              {site.folderPath}
            </p>
            <div className="mt-2 text-[11px] text-blue-800 flex flex-wrap items-center justify-between gap-2">
              <span>{site.syncMessage || 'SharePoint 전용 폴더에 성공적으로 동기화되었습니다.'}</span>
              {site.syncedAt && (
                <span>동기화 시간: {new Date(site.syncedAt).toLocaleString('ko-KR')}</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Attachments Section */}
      <div className="bg-white rounded-2xl border border-slate-200 p-6 sm:p-7 shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-5 border-b border-slate-100 gap-3">
          <div>
            <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <ImageIcon className="w-5 h-5 text-blue-600" />
              시공 사진 및 동영상 갤러리
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              클릭하여 원본 고화질 사진을 확대 확인하거나 동영상을 재생할 수 있습니다.
            </p>
          </div>

          {/* Media Filter Tabs */}
          <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg text-xs font-medium self-start sm:self-auto">
            <button
              type="button"
              onClick={() => setMediaFilter('all')}
              className={`px-3 py-1.5 rounded-md transition-colors ${
                mediaFilter === 'all' ? 'bg-white text-slate-900 shadow-xs font-bold' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              전체 ({site.files.length})
            </button>
            <button
              type="button"
              onClick={() => setMediaFilter('image')}
              className={`px-3 py-1.5 rounded-md transition-colors ${
                mediaFilter === 'image' ? 'bg-white text-emerald-800 shadow-xs font-bold' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              사진 ({photoCount})
            </button>
            <button
              type="button"
              onClick={() => setMediaFilter('video')}
              className={`px-3 py-1.5 rounded-md transition-colors ${
                mediaFilter === 'video' ? 'bg-white text-indigo-800 shadow-xs font-bold' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              동영상 ({videoCount})
            </button>
          </div>
        </div>

        {/* Gallery Grid */}
        {filteredFiles.length === 0 ? (
          <div className="py-12 text-center text-slate-400 text-xs">
            해당 조건의 첨부파일이 없습니다.
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 pt-6">
            {filteredFiles.map((file, idx) => {
              // A file that never reached storage has nothing to stream back,
              // so it shows a placeholder instead of a broken thumbnail.
              const stored = file.status === 'completed';
              const isImg = stored && file.fileType === 'image';
              const isVid = stored && file.fileType === 'video';

              return (
                <div
                  key={file.id}
                  className="group relative bg-slate-50 rounded-xl border border-slate-200 overflow-hidden flex flex-col justify-between hover:shadow-md transition-shadow"
                >
                  {/* Thumbnail / Video Preview Area */}
                  <div
                    onClick={() => stored && onSelectFileForPreview(file)}
                    className={`aspect-video w-full bg-slate-900 relative overflow-hidden flex items-center justify-center ${
                      stored ? 'cursor-pointer' : 'cursor-not-allowed'
                    }`}
                  >
                    {isImg ? (
                      <img
                        src={fileContentUrl(site.id, file.id)}
                        alt={file.originalName}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                        loading="lazy"
                      />
                    ) : isVid ? (
                      <div className="flex flex-col items-center justify-center text-white">
                        <div className="w-10 h-10 rounded-full bg-white/20 backdrop-blur-xs flex items-center justify-center mb-1 group-hover:scale-110 transition-transform">
                          <VideoIcon className="w-5 h-5 text-white" />
                        </div>
                        <span className="text-[10px] uppercase font-semibold tracking-wider text-indigo-200">
                          동영상 재생
                        </span>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-1 text-slate-400 text-xs px-3 text-center">
                        <AlertCircle className="w-5 h-5 text-red-400" />
                        <span>{stored ? '미리보기 불가' : '저장되지 않음'}</span>
                      </div>
                    )}

                    {/* Quick view hover overlay */}
                    {stored && (
                      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                        <span className="px-2.5 py-1 bg-white/90 text-slate-900 rounded-md text-xs font-semibold flex items-center gap-1 shadow-xs">
                          <Eye className="w-3.5 h-3.5" />
                          {isImg ? '확대보기' : '재생'}
                        </span>
                      </div>
                    )}

                    {/* Tag badge */}
                    <span className="absolute top-2 left-2 px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-black/60 text-white">
                      #{idx + 1}
                    </span>
                  </div>

                  {/* File info footer */}
                  <div className="p-3 bg-white border-t border-slate-100 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-slate-800 truncate" title={file.originalName}>
                        {file.originalName}
                      </p>
                      <p className="text-[11px] text-slate-400 font-mono mt-0.5">{file.sizeFormatted}</p>
                      {file.status === 'failed' && (
                        <p
                          className="text-[11px] text-red-600 truncate mt-0.5"
                          title={file.errorMessage}
                        >
                          저장 실패 — 재동기화 필요
                        </p>
                      )}
                    </div>

                    {stored && (
                      <a
                        href={fileContentUrl(site.id, file.id)}
                        download={file.originalName}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="p-1.5 rounded-md hover:bg-slate-100 text-slate-500 hover:text-blue-600 transition-colors shrink-0"
                        title="다운로드"
                      >
                        <Download className="w-4 h-4" />
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
