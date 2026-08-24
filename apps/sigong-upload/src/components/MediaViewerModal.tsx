import React from 'react';
import { X, Download, ZoomIn, ZoomOut, RotateCw, ExternalLink, Image as ImageIcon, Video as VideoIcon } from 'lucide-react';
import { SiteFile } from '../types';
import { fileContentUrl } from '../api';

interface MediaViewerModalProps {
  /** Owning submission — needed to build the authenticated content URL. */
  siteId: string;
  file: SiteFile | null;
  onClose: () => void;
}

export const MediaViewerModal: React.FC<MediaViewerModalProps> = ({ file, siteId, onClose }) => {
  const [zoom, setZoom] = React.useState(1);
  const [rotation, setRotation] = React.useState(0);

  if (!file) return null;

  const contentUrl = fileContentUrl(siteId, file.id);

  const isImage = file.fileType === 'image';
  const isVideo = file.fileType === 'video';

  const handleZoomIn = () => setZoom((prev) => Math.min(prev + 0.25, 3));
  const handleZoomOut = () => setZoom((prev) => Math.max(prev - 0.25, 0.5));
  const handleRotate = () => setRotation((prev) => (prev + 90) % 360);

  return (
    <div
      id="media-viewer-modal"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-xs animate-fadeIn"
      onClick={onClose}
    >
      <div
        className="relative bg-slate-900 text-white rounded-2xl max-w-4xl w-full max-h-[90vh] flex flex-col overflow-hidden border border-slate-700 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Top Bar */}
        <div className="flex items-center justify-between px-5 py-3.5 bg-slate-800/90 border-b border-slate-700">
          <div className="flex items-center gap-2.5 min-w-0">
            {isImage ? (
              <ImageIcon className="w-5 h-5 text-emerald-400 shrink-0" />
            ) : (
              <VideoIcon className="w-5 h-5 text-indigo-400 shrink-0" />
            )}
            <div className="min-w-0">
              <h4 className="text-sm font-bold truncate max-w-xs sm:max-w-md" title={file.originalName}>
                {file.originalName}
              </h4>
              <p className="text-[11px] text-slate-400 font-mono">
                {file.sizeFormatted} • {file.fileType.toUpperCase()}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Image zoom / rotate controls */}
            {isImage && (
              <div className="flex items-center bg-slate-700/60 rounded-lg p-1 mr-1 gap-1">
                <button
                  type="button"
                  onClick={handleZoomIn}
                  className="p-1.5 hover:bg-slate-600 rounded text-slate-200"
                  title="확대"
                >
                  <ZoomIn className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={handleZoomOut}
                  className="p-1.5 hover:bg-slate-600 rounded text-slate-200"
                  title="축소"
                >
                  <ZoomOut className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={handleRotate}
                  className="p-1.5 hover:bg-slate-600 rounded text-slate-200"
                  title="90도 회전"
                >
                  <RotateCw className="w-4 h-4" />
                </button>
              </div>
            )}

            {/* Direct download */}
            <a
              href={contentUrl}
              download={file.originalName}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-xs font-semibold transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              <span>다운로드</span>
            </a>

            {/* Close button */}
            <button
              type="button"
              onClick={onClose}
              className="p-2 hover:bg-slate-700 rounded-lg text-slate-400 hover:text-white transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content Viewer Area */}
        <div className="flex-1 flex items-center justify-center p-4 bg-black/60 min-h-[360px] max-h-[70vh] overflow-auto">
          {isImage ? (
            <img
              src={contentUrl}
              alt={file.originalName}
              style={{
                transform: `scale(${zoom}) rotate(${rotation}deg)`,
                transition: 'transform 0.2s ease',
              }}
              className="max-h-[65vh] max-w-full object-contain rounded-md shadow-md"
            />
          ) : isVideo ? (
            <video
              src={contentUrl}
              controls
              autoPlay
              className="max-h-[65vh] max-w-full rounded-md shadow-md"
            >
              사용하시는 브라우저에서 동영상 재생을 지원하지 않습니다.
            </video>
          ) : (
            <div className="text-center text-slate-400 p-8">
              <p className="text-sm">미리보기를 지원하지 않는 파일 형식입니다.</p>
              <a
                href={contentUrl}
                download={file.originalName}
                className="mt-3 inline-flex items-center gap-1 text-xs text-blue-400 underline"
              >
                다운로드하여 확인
              </a>
            </div>
          )}
        </div>

        {/* Footer info bar */}
        <div className="px-5 py-2.5 bg-slate-800 text-xs text-slate-400 flex items-center justify-between border-t border-slate-700 font-mono">
          {/* Only present for the master — the server strips it for everyone else. */}
          {file.remotePath && (
            <span className="truncate">저장 경로: {file.remotePath}</span>
          )}
          <span className="text-emerald-400 shrink-0 ml-2">상태: 정상 보관됨</span>
        </div>
      </div>
    </div>
  );
};
