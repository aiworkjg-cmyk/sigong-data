import React, { useState } from 'react';
import {
  CheckCircle,
  FolderCheck,
  Calendar,
  User,
  MapPin,
  FileText,
  Copy,
  Check,
  PlusCircle,
  ShieldCheck,
  Image,
  Video,
  ExternalLink
} from 'lucide-react';
import { SiteRecord } from '../types';

interface SubmissionSuccessViewProps {
  site: SiteRecord;
  onNewSubmission: () => void;
  onGoToAdminDetail: (siteId: string) => void;
}

export const SubmissionSuccessView: React.FC<SubmissionSuccessViewProps> = ({
  site,
  onNewSubmission,
  onGoToAdminDetail,
}) => {
  const [copiedId, setCopiedId] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);

  const handleCopyId = () => {
    navigator.clipboard.writeText(site.id);
    setCopiedId(true);
    setTimeout(() => setCopiedId(false), 2000);
  };

  const handleCopyPath = () => {
    navigator.clipboard.writeText(site.sharePointFolderPath);
    setCopiedPath(true);
    setTimeout(() => setCopiedPath(false), 2000);
  };

  const photoCount = site.files.filter((f) => f.fileType === 'image').length;
  const videoCount = site.files.filter((f) => f.fileType === 'video').length;

  return (
    <div className="max-w-2xl mx-auto py-8 px-4 sm:px-6">
      {/* Top Success Banner */}
      <div className="bg-white rounded-2xl border border-slate-200 p-6 sm:p-8 shadow-sm text-center mb-6">
        <div className="w-16 h-16 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto mb-4 shadow-xs">
          <CheckCircle className="w-10 h-10" />
        </div>
        <h2 className="text-2xl font-extrabold text-slate-900 mb-2">
          현장자료 제출이 완료되었습니다
        </h2>
        <p className="text-sm text-slate-600 max-w-md mx-auto leading-relaxed">
          입력하신 현장 정보와 첨부파일이 안전하게 저장되었으며, Microsoft SharePoint 현장 전용 폴더에 분류되었습니다.
        </p>

        <div className="mt-4 inline-flex items-center gap-2 px-3.5 py-1.5 bg-slate-100 rounded-full text-xs font-mono text-slate-700">
          <span>현장 고유 ID:</span>
          <span className="font-bold text-blue-700">{site.id}</span>
          <button
            type="button"
            onClick={handleCopyId}
            className="p-1 hover:text-blue-600 transition-colors"
            title="고유 ID 복사"
          >
            {copiedId ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Summary Card */}
      <div className="bg-white rounded-2xl border border-slate-200 p-6 sm:p-7 shadow-xs mb-6 space-y-5">
        <h3 className="text-base font-bold text-slate-900 border-b border-slate-100 pb-3 flex items-center gap-2">
          <FileText className="w-4 h-4 text-blue-600" />
          제출 현장 정보 요약
        </h3>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
          {/* 담당자 */}
          <div className="bg-slate-50 p-3 rounded-lg border border-slate-100">
            <span className="text-xs text-slate-500 block mb-0.5 flex items-center gap-1">
              <User className="w-3.5 h-3.5 text-slate-400" /> 담당자
            </span>
            <span className="font-semibold text-slate-900">{site.managerName}</span>
          </div>

          {/* 시공일 */}
          <div className="bg-slate-50 p-3 rounded-lg border border-slate-100">
            <span className="text-xs text-slate-500 block mb-0.5 flex items-center gap-1">
              <Calendar className="w-3.5 h-3.5 text-slate-400" /> 시공일
            </span>
            <span className="font-semibold text-slate-900">{site.constructionDate}</span>
          </div>

          {/* 현장 주소 */}
          <div className="bg-slate-50 p-3 rounded-lg border border-slate-100 sm:col-span-2">
            <span className="text-xs text-slate-500 block mb-0.5 flex items-center gap-1">
              <MapPin className="w-3.5 h-3.5 text-slate-400" /> 현장 주소
            </span>
            <span className="font-semibold text-slate-900">{site.address}</span>
          </div>

          {/* 특이사항 */}
          {site.notes && (
            <div className="bg-slate-50 p-3 rounded-lg border border-slate-100 sm:col-span-2">
              <span className="text-xs text-slate-500 block mb-0.5">특이사항</span>
              <p className="text-slate-800 text-xs whitespace-pre-wrap">{site.notes}</p>
            </div>
          )}

          {/* SharePoint Folder Location */}
          <div className="bg-blue-50/70 p-3.5 rounded-lg border border-blue-200 sm:col-span-2">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-blue-900 font-bold flex items-center gap-1.5">
                <FolderCheck className="w-4 h-4 text-blue-700" />
                SharePoint 저장 위치
              </span>
              <button
                type="button"
                onClick={handleCopyPath}
                className="text-xs text-blue-700 hover:text-blue-900 flex items-center gap-1 underline font-medium"
              >
                {copiedPath ? '경로 복사 완료' : '폴더 경로 복사'}
              </button>
            </div>
            <p className="font-mono text-xs text-blue-950 break-all bg-white/80 p-2 rounded border border-blue-100">
              {site.sharePointFolderPath}
            </p>
            <div className="mt-2 flex items-center justify-between text-[11px] text-blue-800">
              <span>동기화 상태: <strong className="text-emerald-700">저장 완료</strong></span>
              <span>제출일시: {new Date(site.createdAt).toLocaleString('ko-KR')}</span>
            </div>
          </div>
        </div>

        {/* Attached Files List Summary */}
        <div className="pt-2">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-bold text-slate-800">
              저장된 첨부파일 (총 {site.files.length}개 / 사진 {photoCount}, 영상 {videoCount})
            </span>
          </div>

          {site.files.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 max-h-48 overflow-y-auto p-1 bg-slate-50 rounded-lg border border-slate-100">
              {site.files.map((file, idx) => (
                <div key={file.id} className="bg-white p-2 rounded border border-slate-200 text-xs flex flex-col justify-between">
                  <div className="flex items-center gap-1 text-[11px] text-slate-500 mb-1">
                    {file.fileType === 'image' ? (
                      <Image className="w-3 h-3 text-emerald-600" />
                    ) : (
                      <Video className="w-3 h-3 text-indigo-600" />
                    )}
                    <span className="truncate font-mono">#{idx + 1}</span>
                  </div>
                  <p className="text-xs font-medium text-slate-800 truncate" title={file.originalName}>
                    {file.originalName}
                  </p>
                  <span className="text-[10px] text-slate-400 mt-1">{file.sizeFormatted}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-400 italic">첨부된 파일이 없습니다.</p>
          )}
        </div>
      </div>

      {/* Action Buttons */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <button
          id="btn-new-submission"
          type="button"
          onClick={onNewSubmission}
          className="w-full py-3 px-4 rounded-xl font-bold text-sm bg-blue-600 hover:bg-blue-700 text-white transition-colors flex items-center justify-center gap-2 shadow-xs"
        >
          <PlusCircle className="w-4 h-4" />
          <span>새 현장자료 등록하기</span>
        </button>

        <button
          id="btn-view-admin-detail"
          type="button"
          onClick={() => onGoToAdminDetail(site.id)}
          className="w-full py-3 px-4 rounded-xl font-bold text-sm bg-slate-800 hover:bg-slate-900 text-white transition-colors flex items-center justify-center gap-2 shadow-xs"
        >
          <ShieldCheck className="w-4 h-4 text-purple-300" />
          <span>관리자 화면에서 확인</span>
        </button>
      </div>
    </div>
  );
};
