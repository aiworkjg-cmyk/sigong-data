import React, { useState, useEffect } from 'react';
import {
  X,
  Folder,
  FolderOpen,
  FileCode,
  FileImage,
  FileVideo,
  File as FileIcon,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  HardDrive,
  ExternalLink,
  Copy,
  Check
} from 'lucide-react';
import { SharePointConfigStatus } from '../types';

interface TreeItem {
  name: string;
  path: string;
  type: 'folder' | 'file';
  size?: number;
  children?: TreeItem[];
}

interface SharePointInspectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  status: SharePointConfigStatus | null;
}

export const SharePointInspectorModal: React.FC<SharePointInspectorModalProps> = ({
  isOpen,
  onClose,
  status,
}) => {
  const [tree, setTree] = useState<TreeItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const fetchTree = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/sharepoint/preview-tree');
      if (res.ok) {
        const data = await res.json();
        setTree(data.tree || []);
      }
    } catch (e) {
      console.error('Failed to load tree:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchTree();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const renderTree = (items: TreeItem[], depth = 0) => {
    if (!items || items.length === 0) {
      return (
        <p className="text-xs text-slate-400 italic py-2 pl-4">
          저장된 하위 폴더/파일이 없습니다.
        </p>
      );
    }

    return (
      <div className="space-y-1">
        {items.map((item) => {
          const isDir = item.type === 'folder';
          const isJson = item.name.endsWith('.json');
          const isImg = item.name.match(/\.(jpg|jpeg|png|webp)$/i);
          const isVid = item.name.match(/\.(mp4|mov|avi)$/i);

          return (
            <div key={item.path} style={{ paddingLeft: `${depth * 18}px` }}>
              <div className="flex items-center gap-2 py-1 px-2 rounded-md hover:bg-slate-100 text-xs font-mono text-slate-700 transition-colors">
                {isDir ? (
                  <FolderOpen className="w-4 h-4 text-amber-500 shrink-0" />
                ) : isJson ? (
                  <FileCode className="w-4 h-4 text-emerald-600 shrink-0" />
                ) : isImg ? (
                  <FileImage className="w-4 h-4 text-blue-500 shrink-0" />
                ) : isVid ? (
                  <FileVideo className="w-4 h-4 text-indigo-500 shrink-0" />
                ) : (
                  <FileIcon className="w-4 h-4 text-slate-400 shrink-0" />
                )}

                <span className={`truncate ${isDir ? 'font-bold text-slate-900' : 'text-slate-700'}`}>
                  {item.name}
                </span>

                {item.size !== undefined && (
                  <span className="text-[10px] text-slate-400 ml-auto">
                    {(item.size / 1024).toFixed(1)} KB
                  </span>
                )}
              </div>

              {isDir && item.children && renderTree(item.children, depth + 1)}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div
      id="sharepoint-inspector-modal"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-fadeIn"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl max-w-2xl w-full p-6 sm:p-7 shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 pb-4 mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-100 text-blue-700 flex items-center justify-center">
              <HardDrive className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900">
                Microsoft SharePoint 연동 및 폴더 구조
              </h3>
              <p className="text-xs text-slate-500">
                시공현장별 자동 생성되는 계층형 폴더 및 파일 아카이브 구조
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-700"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Status Callout */}
        <div className="mb-4 p-4 rounded-xl bg-slate-50 border border-slate-200 text-xs">
          <div className="flex items-center justify-between mb-2">
            <span className="font-bold text-slate-800 flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              현재 동작 모드:
            </span>
            <span
              className={`px-2.5 py-0.5 rounded-full font-bold uppercase text-[10px] ${
                status?.mode === 'LIVE'
                  ? 'bg-emerald-100 text-emerald-800'
                  : 'bg-blue-100 text-blue-800'
              }`}
            >
              {status?.mode === 'LIVE' ? '실제 SharePoint 클라우드 연동' : '테스트 저장 모드 (구조 검증)'}
            </span>
          </div>

          <p className="text-slate-600 leading-relaxed mb-3">
            {status?.message || '현장 제출 시 SharePoint 폴더 규칙에 맞추어 현장정보 및 사진·동영상이 자동 저장됩니다.'}
          </p>

          <div className="bg-white p-3 rounded-lg border border-slate-200 font-mono text-[11px] text-slate-700 space-y-1">
            <div className="font-bold text-slate-900 mb-1">📁 표준 폴더 명명 규칙:</div>
            <div className="text-blue-700">시공현장자료/</div>
            <div className="pl-4 text-blue-700">└── YYYY-MM/ (예: 2026-08)</div>
            <div className="pl-8 text-blue-700">└── YYYY-MM-DD_현장주소_담당자/</div>
            <div className="pl-12 text-slate-600">├── 현장정보.json (현장 고유 ID, 시공일, 특이사항 등)</div>
            <div className="pl-12 text-slate-600">└── 첨부파일/ (사진 및 동영상 원본)</div>
          </div>
        </div>

        {/* Folder Tree Preview */}
        <div className="flex-1 overflow-y-auto border border-slate-200 rounded-xl p-4 bg-slate-50/50 mb-4 min-h-[160px]">
          <div className="flex items-center justify-between mb-2 pb-2 border-b border-slate-200 text-xs text-slate-600 font-semibold">
            <span>로컬 / SharePoint 저장소 트리</span>
            <button
              type="button"
              onClick={fetchTree}
              disabled={loading}
              className="flex items-center gap-1 text-[11px] text-blue-600 hover:text-blue-800"
            >
              <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
              새로고침
            </button>
          </div>

          {loading ? (
            <div className="py-8 text-center text-xs text-slate-400">폴더 구조 불러오는 중...</div>
          ) : (
            <div className="space-y-1">{renderTree(tree)}</div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-900 text-white rounded-lg text-xs font-semibold"
          >
            확인 및 닫기
          </button>
        </div>
      </div>
    </div>
  );
};
