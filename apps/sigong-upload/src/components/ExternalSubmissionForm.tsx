import React, { useState, useRef } from 'react';
import {
  Upload,
  Calendar,
  User,
  MapPin,
  FileText,
  Image,
  Video,
  Trash2,
  AlertTriangle,
  CheckCircle2,
  Info,
  Shield,
  Clock,
  Sparkles
} from 'lucide-react';

interface SelectedFileItem {
  id: string;
  file: File;
  previewUrl: string;
  isImage: boolean;
  isVideo: boolean;
  sizeFormatted: string;
}

interface ExternalSubmissionFormProps {
  onSubmit: (formData: {
    constructionType: string;
    managerName: string;
    address: string;
    constructionDate: string;
    notes: string;
    files: File[];
  }) => void;
  isSubmitting: boolean;
  /** Selectable 시공종류, served by the API so the list stays configurable. */
  constructionTypes: string[];
}

const MAX_FILES = 50;
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100MB

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Get today formatted as YYYY-MM-DD
function getTodayString(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export const ExternalSubmissionForm: React.FC<ExternalSubmissionFormProps> = ({
  onSubmit,
  isSubmitting,
  constructionTypes,
}) => {
  const [constructionType, setConstructionType] = useState('');
  const [managerName, setManagerName] = useState('');
  const [address, setAddress] = useState('');
  const [constructionDate, setConstructionDate] = useState(getTodayString());
  const [notes, setNotes] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<SelectedFileItem[]>([]);
  
  // Validation errors
  const [errors, setErrors] = useState<{
    constructionType?: string;
    managerName?: string;
    address?: string;
    constructionDate?: string;
    files?: string;
  }>({});

  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Validate single or multiple files against rules (max 50, max 100MB per file, photo/video type)
  const processIncomingFiles = (incomingList: FileList | File[]) => {
    const newErrors = { ...errors };
    delete newErrors.files;

    const added: SelectedFileItem[] = [];
    const rejectedReasons: string[] = [];

    const currentCount = selectedFiles.length;
    let allowedCount = MAX_FILES - currentCount;

    if (allowedCount <= 0) {
      setErrors((prev) => ({
        ...prev,
        files: `파일은 최대 ${MAX_FILES}개까지만 업로드할 수 있습니다. (현재 ${selectedFiles.length}개 선택됨)`,
      }));
      return;
    }

    Array.from(incomingList).forEach((file) => {
      // 1. Check count limit
      if (added.length >= allowedCount) {
        rejectedReasons.push(`최대 개수(${MAX_FILES}개) 초과로 일부 파일이 제외되었습니다.`);
        return;
      }

      // 2. Check individual size limit (100MB)
      if (file.size > MAX_FILE_SIZE_BYTES) {
        rejectedReasons.push(`[${file.name}]의 용량이 100MB를 초과하여 제외되었습니다. (${formatBytes(file.size)})`);
        return;
      }

      // 3. Check format (photo or video)
      const isImage = file.type.startsWith('image/');
      const isVideo = file.type.startsWith('video/');
      if (!isImage && !isVideo) {
        rejectedReasons.push(`[${file.name}]은 사진 또는 동영상 형식이 아니어서 제외되었습니다.`);
        return;
      }

      // Generate preview
      let previewUrl = '';
      if (isImage) {
        previewUrl = URL.createObjectURL(file);
      }

      added.push({
        id: `sel-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        file,
        previewUrl,
        isImage,
        isVideo,
        sizeFormatted: formatBytes(file.size),
      });
    });

    if (added.length > 0) {
      setSelectedFiles((prev) => [...prev, ...added]);
    }

    if (rejectedReasons.length > 0) {
      setErrors((prev) => ({
        ...prev,
        files: rejectedReasons.join(' | '),
      }));
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processIncomingFiles(e.target.files);
      e.target.value = ''; // reset so same files can be re-picked if needed
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processIncomingFiles(e.dataTransfer.files);
    }
  };

  const handleRemoveFile = (id: string) => {
    setSelectedFiles((prev) => {
      const target = prev.find((f) => f.id === id);
      if (target && target.previewUrl) {
        URL.revokeObjectURL(target.previewUrl);
      }
      return prev.filter((f) => f.id !== id);
    });
    // Clear files error if any
    setErrors((prev) => {
      const copy = { ...prev };
      delete copy.files;
      return copy;
    });
  };

  const handleRemoveAllFiles = () => {
    selectedFiles.forEach((f) => {
      if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
    });
    setSelectedFiles([]);
    setErrors((prev) => {
      const copy = { ...prev };
      delete copy.files;
      return copy;
    });
  };

  const validateForm = (): boolean => {
    const errs: typeof errors = {};

    if (!managerName.trim()) {
      errs.managerName = '담당자 이름을 입력해 주세요.';
    }

    if (!constructionType) {
      errs.constructionType = '시공종류를 선택해 주세요.';
    }

    if (!address.trim()) {
      errs.address = '현장 주소를 입력해 주세요.';
    }

    if (!constructionDate) {
      errs.constructionDate = '시공일을 달력에서 선택해 주세요.';
    }

    if (selectedFiles.length > MAX_FILES) {
      errs.files = `첨부파일은 최대 ${MAX_FILES}개까지 등록할 수 있습니다.`;
    }

    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    if (!validateForm()) {
      // Scroll to first error
      window.scrollTo({ top: 100, behavior: 'smooth' });
      return;
    }

    onSubmit({
      constructionType,
      managerName: managerName.trim(),
      address: address.trim(),
      constructionDate,
      notes: notes.trim(),
      files: selectedFiles.map((item) => item.file),
    });
  };

  // Quick date presets
  const setDatePreset = (offsetDays: number) => {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    setConstructionDate(`${y}-${m}-${day}`);
    setErrors((prev) => ({ ...prev, constructionDate: undefined }));
  };

  const photoCount = selectedFiles.filter((f) => f.isImage).length;
  const videoCount = selectedFiles.filter((f) => f.isVideo).length;
  const totalSizeBytes = selectedFiles.reduce((acc, f) => acc + f.file.size, 0);

  return (
    <div className="max-w-3xl mx-auto py-6 sm:py-10 px-4 sm:px-6">
      {/* Top Banner — title only. Upload limits are stated at the dropzone,
          where they actually matter, so they are not repeated here. */}
      <div className="bg-gradient-to-r from-blue-700 to-indigo-800 text-white rounded-xl px-5 py-4 sm:px-6 sm:py-5 mb-8 shadow-md">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-white/15 rounded-lg backdrop-blur-xs shrink-0">
            <Sparkles className="w-5 h-5 text-blue-200" />
          </div>
          <h2 className="text-xl sm:text-2xl font-bold">시공현장 자료 제출</h2>
        </div>
      </div>

      {/* Main Form */}
      <form id="form-site-submission" onSubmit={handleSubmit} className="space-y-6">
        {/* Card 1: 기본 정보 (담당자, 주소, 시공일) */}
        <div className="bg-white rounded-xl border border-slate-200 p-6 sm:p-7 shadow-xs">
          <div className="border-b border-slate-100 pb-4 mb-5 flex items-center justify-between">
            <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <User className="w-5 h-5 text-blue-600" />
              현장 기본 정보
            </h3>
            <span className="text-xs text-rose-600 font-medium">* 필수 입력 항목</span>
          </div>

          <div className="space-y-5">
            {/* 0. 시공종류 — chosen from a fixed list, never typed, because the
                 value becomes a folder name in the document library. */}
            <div>
              <label className="block text-sm font-semibold text-slate-800 mb-1.5">
                시공종류 <span className="text-rose-500">*</span>
              </label>
              <div
                id="construction-type-group"
                role="radiogroup"
                aria-label="시공종류"
                className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2"
              >
                {constructionTypes.map((type) => {
                  const selected = constructionType === type;
                  return (
                    <button
                      key={type}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => {
                        setConstructionType(type);
                        setErrors((prev) => ({ ...prev, constructionType: undefined }));
                      }}
                      className={`px-3 py-3 rounded-xl border-2 text-sm font-bold transition-colors ${
                        selected
                          ? 'border-blue-600 bg-blue-50 text-blue-800'
                          : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      {type}
                    </button>
                  );
                })}
              </div>
              {errors.constructionType && (
                <p className="mt-1.5 text-xs text-rose-600 flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  {errors.constructionType}
                </p>
              )}
            </div>

            {/* 1. 담당자 이름 */}
            <div>
              <label htmlFor="input-manager-name" className="block text-sm font-semibold text-slate-800 mb-1.5">
                담당자 이름 <span className="text-rose-500">*</span>
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                  <User className="w-4 h-4" />
                </div>
                <input
                  id="input-manager-name"
                  type="text"
                  value={managerName}
                  onChange={(e) => {
                    setManagerName(e.target.value);
                    if (errors.managerName) {
                      setErrors((prev) => ({ ...prev, managerName: undefined }));
                    }
                  }}
                  placeholder="예: 홍길동 팀장"
                  className={`w-full pl-10 pr-4 py-2.5 rounded-lg border text-sm focus:outline-hidden focus:ring-2 transition-all ${
                    errors.managerName
                      ? 'border-rose-300 focus:ring-rose-200 bg-rose-50/30'
                      : 'border-slate-300 focus:border-blue-500 focus:ring-blue-100'
                  }`}
                  disabled={isSubmitting}
                />
              </div>
              {errors.managerName && (
                <p className="mt-1.5 text-xs text-rose-600 flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  {errors.managerName}
                </p>
              )}
            </div>

            {/* 2. 현장 주소 */}
            <div>
              <label htmlFor="input-address" className="block text-sm font-semibold text-slate-800 mb-1.5">
                현장 주소 <span className="text-rose-500">*</span>
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                  <MapPin className="w-4 h-4" />
                </div>
                <input
                  id="input-address"
                  type="text"
                  value={address}
                  onChange={(e) => {
                    setAddress(e.target.value);
                    if (errors.address) {
                      setErrors((prev) => ({ ...prev, address: undefined }));
                    }
                  }}
                  placeholder="예: 경기 광명시 하안로 60 광명SK테크노파크 A동 702호"
                  className={`w-full pl-10 pr-4 py-2.5 rounded-lg border text-sm focus:outline-hidden focus:ring-2 transition-all ${
                    errors.address
                      ? 'border-rose-300 focus:ring-rose-200 bg-rose-50/30'
                      : 'border-slate-300 focus:border-blue-500 focus:ring-blue-100'
                  }`}
                  disabled={isSubmitting}
                />
              </div>
              {errors.address && (
                <p className="mt-1.5 text-xs text-rose-600 flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  {errors.address}
                </p>
              )}
            </div>

            {/* 3. 시공일 (달력 선택 방식) */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label htmlFor="input-construction-date" className="block text-sm font-semibold text-slate-800">
                  시공일 (달력 선택) <span className="text-rose-500">*</span>
                </label>
                {/* Quick Presets */}
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setDatePreset(0)}
                    className="text-xs px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-md transition-colors"
                  >
                    오늘
                  </button>
                  <button
                    type="button"
                    onClick={() => setDatePreset(-1)}
                    className="text-xs px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-md transition-colors"
                  >
                    어제
                  </button>
                </div>
              </div>

              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                  <Calendar className="w-4 h-4" />
                </div>
                <input
                  id="input-construction-date"
                  type="date"
                  value={constructionDate}
                  onChange={(e) => {
                    setConstructionDate(e.target.value);
                    if (errors.constructionDate) {
                      setErrors((prev) => ({ ...prev, constructionDate: undefined }));
                    }
                  }}
                  className={`w-full pl-10 pr-4 py-2.5 rounded-lg border text-sm focus:outline-hidden focus:ring-2 transition-all ${
                    errors.constructionDate
                      ? 'border-rose-300 focus:ring-rose-200 bg-rose-50/30'
                      : 'border-slate-300 focus:border-blue-500 focus:ring-blue-100'
                  }`}
                  disabled={isSubmitting}
                />
              </div>
              <p className="mt-1 text-xs text-slate-500">
                선택된 시공일: <span className="font-semibold text-slate-700">{constructionDate || '미선택'}</span>
              </p>
              {errors.constructionDate && (
                <p className="mt-1.5 text-xs text-rose-600 flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  {errors.constructionDate}
                </p>
              )}
            </div>

            {/* 4. 특이사항 */}
            <div>
              <label htmlFor="textarea-notes" className="block text-sm font-semibold text-slate-800 mb-1.5">
                특이사항 <span className="text-xs text-slate-400 font-normal">(선택 입력)</span>
              </label>
              <textarea
                id="textarea-notes"
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="시공 특이사항, 자재 변경 내역, 추가 보수 필요 사항 등을 입력해 주세요."
                className="w-full px-4 py-2.5 rounded-lg border border-slate-300 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 text-sm focus:outline-hidden transition-all"
                disabled={isSubmitting}
              />
            </div>
          </div>
        </div>

        {/* Card 2: 사진 및 동영상 업로드 */}
        <div className="bg-white rounded-xl border border-slate-200 p-6 sm:p-7 shadow-xs">
          <div className="border-b border-slate-100 pb-4 mb-5 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                <Upload className="w-5 h-5 text-blue-600" />
                사진·동영상 첨부
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                현장 시공 전/후 사진 및 작업 동영상을 선택해 주세요.
              </p>
            </div>

            {/* File Count & Size Status */}
            <div className="flex items-center gap-2">
              <span
                id="file-count-badge"
                className={`text-xs px-3 py-1 rounded-full font-bold transition-colors ${
                  selectedFiles.length >= MAX_FILES
                    ? 'bg-amber-100 text-amber-800 border border-amber-300'
                    : selectedFiles.length > 0
                    ? 'bg-blue-100 text-blue-800 border border-blue-200'
                    : 'bg-slate-100 text-slate-600 border border-slate-200'
                }`}
              >
                선택된 파일: {selectedFiles.length} / {MAX_FILES}
              </span>
              {selectedFiles.length > 0 && (
                <button
                  type="button"
                  onClick={handleRemoveAllFiles}
                  className="text-xs text-slate-500 hover:text-rose-600 underline transition-colors"
                  disabled={isSubmitting}
                >
                  전체 삭제
                </button>
              )}
            </div>
          </div>

          {/* Hidden File Input */}
          <input
            ref={fileInputRef}
            id="file-upload-input"
            type="file"
            multiple
            accept="image/*,video/*"
            onChange={handleFileChange}
            className="hidden"
            disabled={isSubmitting}
          />

          {/* Drag & Drop Zone */}
          <div
            id="dropzone-area"
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-xl p-6 sm:p-8 text-center cursor-pointer transition-all ${
              dragOver
                ? 'border-blue-500 bg-blue-50/50 scale-[1.005]'
                : 'border-slate-300 hover:border-blue-400 bg-slate-50/50 hover:bg-slate-50'
            }`}
          >
            <div className="w-12 h-12 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center mx-auto mb-3">
              <Upload className="w-6 h-6" />
            </div>
            <p className="text-sm font-semibold text-slate-800 mb-1">
              파일을 여기로 드래그하거나 <span className="text-blue-600 underline">파일 선택</span>을 클릭하세요
            </p>
            <p className="text-xs text-slate-500">
              모바일에서는 사진 보관함 또는 카메라로 즉시 촬영하여 첨부할 수 있습니다.
            </p>

            <div className="mt-4 flex flex-wrap items-center justify-center gap-3 text-xs text-slate-600">
              <span className="bg-white px-2.5 py-1 rounded-md border border-slate-200">
                📷 사진 (JPG, PNG, WEBP 등)
              </span>
              <span className="bg-white px-2.5 py-1 rounded-md border border-slate-200">
                🎥 동영상 (MP4, MOV 등)
              </span>
              <span className="bg-white px-2.5 py-1 rounded-md border border-slate-200 font-medium text-blue-700">
                최대 50개 / 파일당 100MB 이하
              </span>
            </div>
          </div>

          {/* Validation Error for files */}
          {errors.files && (
            <div className="mt-3 p-3 bg-rose-50 border border-rose-200 rounded-lg flex items-start gap-2 text-xs text-rose-700">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{errors.files}</span>
            </div>
          )}

          {/* Selected Files Grid Preview */}
          {selectedFiles.length > 0 && (
            <div className="mt-6">
              <div className="flex items-center justify-between mb-3 text-xs text-slate-600">
                <span className="font-semibold text-slate-800">
                  첨부 목록 (사진 {photoCount}개, 영상 {videoCount}개, 총 {formatBytes(totalSizeBytes)})
                </span>
                <span>{selectedFiles.length}개 파일 준비됨</span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 max-h-96 overflow-y-auto p-1">
                {selectedFiles.map((item, index) => (
                  <div
                    key={item.id}
                    className="relative group rounded-lg border border-slate-200 bg-white p-2 flex flex-col justify-between shadow-2xs hover:shadow-xs transition-shadow"
                  >
                    {/* Thumbnail / Icon */}
                    <div className="aspect-video w-full rounded-md bg-slate-100 overflow-hidden relative flex items-center justify-center mb-2">
                      {item.isImage && item.previewUrl ? (
                        <img
                          src={item.previewUrl}
                          alt={item.file.name}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="flex flex-col items-center justify-center text-slate-500">
                          <Video className="w-8 h-8 text-indigo-500 mb-1" />
                          <span className="text-[10px] font-medium uppercase bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded">
                            동영상
                          </span>
                        </div>
                      )}

                      {/* Number badge */}
                      <span className="absolute top-1 left-1 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded font-mono">
                        #{index + 1}
                      </span>
                    </div>

                    {/* File info */}
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-slate-800 truncate" title={item.file.name}>
                        {item.file.name}
                      </p>
                      <p className="text-[11px] text-slate-500 mt-0.5">{item.sizeFormatted}</p>
                    </div>

                    {/* Delete button */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemoveFile(item.id);
                      }}
                      className="absolute top-1 right-1 p-1 bg-rose-600 text-white rounded-md opacity-90 hover:opacity-100 transition-opacity shadow-xs"
                      title="파일 삭제"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Warning & Submit Section */}
        <div className="bg-slate-50 rounded-xl border border-slate-200 p-5">
          <div className="flex items-start gap-3 text-xs text-slate-600 mb-4">
            <Info className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-slate-800 mb-0.5">안전한 데이터 보관 안내</p>
              <p>
                파일 전송이 끝나면 바로 완료 화면으로 넘어갑니다. 전송 중에는 브라우저 화면을 유지해 주세요.
              </p>
            </div>
          </div>

          <button
            id="btn-submit-site"
            type="submit"
            disabled={isSubmitting}
            className={`w-full py-3.5 px-6 rounded-xl font-bold text-base text-white transition-all shadow-md flex items-center justify-center gap-2 ${
              isSubmitting
                ? 'bg-slate-400 cursor-not-allowed'
                : 'bg-blue-600 hover:bg-blue-700 active:scale-[0.99] cursor-pointer'
            }`}
          >
            {isSubmitting ? (
              <>
                <Clock className="w-5 h-5 animate-spin" />
                <span>현장자료 업로드 및 저장 중...</span>
              </>
            ) : (
              <>
                <CheckCircle2 className="w-5 h-5" />
                <span>현장자료 최종 제출하기</span>
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
};
