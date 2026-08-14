import React from 'react';
import { Loader2, AlertCircle, CheckCircle2, AlertTriangle, FileText, Image, Video, ShieldAlert } from 'lucide-react';
import { UploadProgressItem } from '../types';

interface UploadProgressModalProps {
  isOpen: boolean;
  overallProgress: number;
  progressItems: UploadProgressItem[];
  currentStage: string;
  errorMessage: string | null;
  onCloseError: () => void;
}

export const UploadProgressModal: React.FC<UploadProgressModalProps> = ({
  isOpen,
  overallProgress,
  progressItems,
  currentStage,
  errorMessage,
  onCloseError,
}) => {
  if (!isOpen) return null;

  const isFailed = Boolean(errorMessage);
  const isFinished = overallProgress >= 100 && !isFailed;

  return (
    <div
      id="upload-progress-modal"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/70 backdrop-blur-xs animate-fadeIn"
    >
      <div className="bg-white rounded-2xl max-w-lg w-full p-6 sm:p-7 shadow-2xl border border-slate-200 overflow-hidden">
        {/* Header with status icon */}
        <div className="flex items-center gap-3.5 mb-5">
          {isFailed ? (
            <div className="w-12 h-12 rounded-xl bg-rose-100 text-rose-600 flex items-center justify-center shrink-0">
              <AlertCircle className="w-7 h-7" />
            </div>
          ) : isFinished ? (
            <div className="w-12 h-12 rounded-xl bg-emerald-100 text-emerald-600 flex items-center justify-center shrink-0">
              <CheckCircle2 className="w-7 h-7" />
            </div>
          ) : (
            <div className="w-12 h-12 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center shrink-0">
              <Loader2 className="w-7 h-7 animate-spin" />
            </div>
          )}

          <div>
            <h3 className="text-lg font-bold text-slate-900">
              {isFailed
                ? '현장자료 제출 중 오류 발생'
                : isFinished
                ? '저장 및 SharePoint 연동 완료 중...'
                : '현장자료 업로드 및 저장 중'}
            </h3>
            <p className="text-xs text-slate-500 mt-0.5 font-medium">
              {isFailed
                ? '아래 오류 원인을 확인한 후 다시 시도해 주십시오.'
                : currentStage || '서버 및 SharePoint 저장소로 전송 중입니다.'}
            </p>
          </div>
        </div>

        {/* Warning Callout during active upload */}
        {!isFailed && (
          <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-xl mb-5 text-xs text-amber-900 flex items-start gap-2.5">
            <ShieldAlert className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <span className="font-bold">주의: </span>
              파일 업로드 및 저장이 진행 중입니다. 완료될 때까지 브라우저 화면을 닫거나 새로고침하지 마십시오.
            </div>
          </div>
        )}

        {/* Error Callout if failed */}
        {isFailed && (
          <div className="p-4 bg-rose-50 border border-rose-200 rounded-xl mb-5 text-xs text-rose-800 space-y-1">
            <div className="flex items-center gap-1.5 font-bold text-rose-900">
              <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
              <span>실패 단계: {currentStage}</span>
            </div>
            <p className="pl-5 leading-relaxed">{errorMessage}</p>
          </div>
        )}

        {/* Overall Progress Bar */}
        <div className="mb-5">
          <div className="flex items-center justify-between text-xs font-semibold text-slate-700 mb-1.5">
            <span>전체 처리 진행률</span>
            <span className="font-mono text-blue-700 font-bold">{overallProgress}%</span>
          </div>
          <div className="w-full h-3 bg-slate-100 rounded-full overflow-hidden border border-slate-200 p-0.5">
            <div
              className={`h-full rounded-full transition-all duration-300 ${
                isFailed
                  ? 'bg-rose-500'
                  : isFinished
                  ? 'bg-emerald-500'
                  : 'bg-gradient-to-r from-blue-500 to-indigo-600'
              }`}
              style={{ width: `${overallProgress}%` }}
            />
          </div>
        </div>

        {/* Per-file Progress List */}
        {progressItems.length > 0 && (
          <div className="mb-5">
            <div className="text-xs font-semibold text-slate-700 mb-2 flex items-center justify-between">
              <span>파일별 업로드 현황 ({progressItems.length}개)</span>
              <span className="text-[11px] text-slate-500">
                완료: {progressItems.filter((p) => p.status === 'completed').length} / {progressItems.length}
              </span>
            </div>
            <div className="max-h-48 overflow-y-auto space-y-2 pr-1 rounded-lg border border-slate-100 p-2 bg-slate-50/50">
              {progressItems.map((item) => (
                <div
                  key={item.fileId}
                  className="bg-white p-2.5 rounded-lg border border-slate-200 text-xs shadow-2xs"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-medium text-slate-800 truncate max-w-[200px]" title={item.fileName}>
                      {item.fileName}
                    </span>
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase ${
                        item.status === 'completed'
                          ? 'bg-emerald-100 text-emerald-700'
                          : item.status === 'uploading'
                          ? 'bg-blue-100 text-blue-700'
                          : item.status === 'failed'
                          ? 'bg-rose-100 text-rose-700'
                          : 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {item.status === 'completed'
                        ? '완료'
                        : item.status === 'uploading'
                        ? '업로드 중'
                        : item.status === 'failed'
                        ? '실패'
                        : '대기'}
                    </span>
                  </div>

                  <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        item.status === 'failed'
                          ? 'bg-rose-500'
                          : item.status === 'completed'
                          ? 'bg-emerald-500'
                          : 'bg-blue-500'
                      }`}
                      style={{ width: `${item.progress}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Footer actions */}
        {isFailed && (
          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={onCloseError}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-900 text-white rounded-lg text-xs font-semibold transition-colors"
            >
              닫기 및 수정하기
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
