import React, { useEffect, useState } from 'react';
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
  Image,
  Video,
  Loader2,
  AlertTriangle,
  ExternalLink
} from 'lucide-react';
import { SiteRecord, SubmissionStatus } from '../types';
import { publicApi } from '../api';
import { statusMeta } from '../status';

interface SubmissionSuccessViewProps {
  site: SiteRecord;
  onNewSubmission: () => void;
}

export const SubmissionSuccessView: React.FC<SubmissionSuccessViewProps> = ({
  site,
  onNewSubmission,
}) => {
  const [copiedId, setCopiedId] = useState(false);

  // Filing into the library continues after the response, so the submitter is
  // shown live progress instead of a completion claim that may not hold.
  const [progress, setProgress] = useState<SubmissionStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const next = await publicApi.submissionStatus(site.id);
        if (cancelled) return;
        setProgress(next);
        if (statusMeta(next.status).inFlight) timer = setTimeout(poll, 3000);
      } catch {
        // A transient failure just means the next tick tries again.
        if (!cancelled) timer = setTimeout(poll, 8000);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [site.id]);

  const handleCopyId = () => {
    navigator.clipboard.writeText(site.id);
    setCopiedId(true);
    setTimeout(() => setCopiedId(false), 2000);
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
          제출하신 현장 정보와 첨부파일이 정상적으로 접수되었습니다.
          이 화면을 닫으셔도 보관 처리는 계속 진행됩니다.
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

          {/* Live filing progress. The internal folder path is deliberately not
              shown here, since this page is opened by external submitters. */}
          <div className="bg-blue-50/70 p-3.5 rounded-lg border border-blue-200 sm:col-span-2">
            <span className="text-xs text-blue-900 font-bold flex items-center gap-1.5 mb-1">
              <FolderCheck className="w-4 h-4 text-blue-700" />
              보관 상태
            </span>

            <div className="flex items-start gap-2">
              {progress && statusMeta(progress.status).inFlight && (
                <Loader2 className="w-4 h-4 text-blue-600 animate-spin shrink-0 mt-0.5" />
              )}
              {progress?.status === 'FAILED' || progress?.status === 'PARTIAL' ? (
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              ) : null}
              <p className="text-xs text-blue-950 leading-relaxed">
                {progress?.message || '접수되었습니다. 보관 상태를 확인하는 중입니다.'}
              </p>
            </div>

            {progress && progress.totalFiles > 0 && (
              <div className="mt-2.5">
                <div className="h-1.5 bg-white rounded-full overflow-hidden border border-blue-100">
                  <div
                    className={`h-full transition-all duration-500 ${
                      progress.status === 'FAILED'
                        ? 'bg-red-500'
                        : progress.status === 'PARTIAL'
                          ? 'bg-amber-500'
                          : 'bg-blue-600'
                    }`}
                    style={{
                      width: `${Math.round((progress.storedFiles / progress.totalFiles) * 100)}%`,
                    }}
                  />
                </div>
                <p className="mt-1 text-[11px] text-blue-800">
                  보관 완료 {progress.storedFiles} / {progress.totalFiles}개
                </p>
              </div>
            )}

            <div className="mt-2 flex items-center justify-between text-[11px] text-blue-800">
              <span>
                상태:{' '}
                <strong
                  className={
                    progress?.status === 'COMPLETED'
                      ? 'text-emerald-700'
                      : progress?.status === 'FAILED'
                        ? 'text-red-700'
                        : 'text-amber-700'
                  }
                >
                  {statusMeta(progress?.status ?? 'QUEUED').label}
                </strong>
              </span>
              <span>제출일시: {new Date(site.createdAt).toLocaleString('ko-KR')}</span>
            </div>

            {(progress?.status === 'FAILED' || progress?.status === 'PARTIAL') && (
              <p className="mt-2 p-2 rounded bg-amber-50 border border-amber-200 text-[11px] text-amber-900">
                담당 관리자에게 자동으로 알림이 전송되었습니다. 현장 ID를 함께 알려 주시면 처리가 빠릅니다.
              </p>
            )}
          </div>
        </div>

        {/* Attached Files List Summary */}
        <div className="pt-2">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-bold text-slate-800">
              제출한 첨부파일 (총 {site.files.length}개 / 사진 {photoCount}, 영상 {videoCount})
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
      <div>
        <button
          id="btn-new-submission"
          type="button"
          onClick={onNewSubmission}
          className="w-full py-3 px-4 rounded-xl font-bold text-sm bg-blue-600 hover:bg-blue-700 text-white transition-colors flex items-center justify-center gap-2 shadow-xs"
        >
          <PlusCircle className="w-4 h-4" />
          <span>새 현장자료 등록하기</span>
        </button>
      </div>
    </div>
  );
};
