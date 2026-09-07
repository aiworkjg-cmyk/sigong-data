import React, { useEffect, useState, useRef } from 'react';
import { TechnicianPicker } from './TechnicianPicker';
import { WorkOrderPicker } from './WorkOrderPicker';
import { WorkOrderCalendarPicker } from './WorkOrderCalendarPicker';
import { DEFAULT_SUBMISSION_ORDER } from '../submission-layout';
import type { SubmissionFieldKey } from '../submission-layout';
import { ConstructionTypePicker } from './ConstructionTypePicker';
import type { ConstructionTypeConfig, Technician, WorkOrder } from '../types';
import {
  Upload,
  Calendar,
  HardHat,
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
    fieldValues: Record<string, string>;
    technicianIds: string[];
    address: string;
    constructionDate: string;
    notes: string;
    files: File[];
    /** 직접 입력일 때만 채워집니다. 목록에서 골랐으면 그 주문건의 값을 씁니다. */
    customerName: string;
    /** 목록에서 고른 시공건. 직접 입력이면 빈 문자열입니다. */
    workOrderId: string;
  }) => void;
  isSubmitting: boolean;
  /** Selectable 시공종류, served by the API so the list stays configurable. */
  constructionTypes: string[];
  constructionTypeConfigs: ConstructionTypeConfig[];
  /** Selectable 시공기사 명부, likewise served by the API. */
  technicians: Technician[];
  /** 시공종류별 입력 항목 차례. 설정에서 정합니다. */
  submissionOrders?: Record<string, SubmissionFieldKey[]>;
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
  constructionTypeConfigs,
  technicians,
  submissionOrders = {},
}) => {
  const [constructionType, setConstructionType] = useState('');
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [technicianIds, setTechnicianIds] = useState<string[]>([]);
  const [workOrder, setWorkOrder] = useState<WorkOrder | null>(null);
  /**
   * 목록을 건너뛰고 직접 입력하는 중인지.
   *
   * 목록이 비어 있을 때 자동으로 켜지지는 않습니다. 주문서 등록이 늦은 것과
   * 정말로 목록에 없는 현장인 것은 다른 상황이고, 기사가 그 둘을 구분해서
   * 누르게 해야 관리자가 나중에 무엇을 대조해야 하는지 알 수 있습니다.
   */
  const [manualEntry, setManualEntry] = useState(false);
  /**
   * 시공건을 고르는 방식. 목록에서 훑거나, 달력에서 날짜를 짚거나.
   *
   * 브라우저에 기억시킵니다 — 한 기사는 늘 같은 방식을 쓰는데 화면을 열
   * 때마다 다시 고르게 하면 그 자체가 매번 한 번의 실수 기회가 됩니다.
   */
  const [pickerMode, setPickerMode] = useState<'list' | 'calendar'>(() => {
    try {
      return localStorage.getItem('workOrderPickerMode') === 'calendar' ? 'calendar' : 'list';
    } catch {
      return 'list';
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('workOrderPickerMode', pickerMode);
    } catch {
      // 사생활 보호 모드에서는 저장이 막힙니다. 기억하지 못할 뿐입니다.
    }
  }, [pickerMode]);
  /**
   * 목록을 거를 시공일.
   *
   * 제출되는 constructionDate 와 따로 둡니다. 기사는 "오늘 갈 현장"을 찾으려고
   * 날짜를 고르는 것이고, 실제로 저장될 시공일은 고른 주문건에서 옵니다.
   */
  const [pickDate, setPickDate] = useState(getTodayString());
  const [address, setAddress] = useState('');
  /** 직접 입력일 때만 받습니다. 주문건을 골랐으면 그 값을 씁니다. */
  const [customerName, setCustomerName] = useState('');
  const [constructionDate, setConstructionDate] = useState(getTodayString());
  const [notes, setNotes] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<SelectedFileItem[]>([]);
  /** 목록에서 체크한 파일. 여러 장을 한 번에 빼낼 때 씁니다. */
  const [pickedFiles, setPickedFiles] = useState<Set<string>>(new Set());
  
  // Validation errors
  const [errors, setErrors] = useState<{
    constructionType?: string;
    customFields?: Record<string, string>;
    technicians?: string;
    customerName?: string;
    address?: string;
    constructionDate?: string;
    files?: string;
  }>({});

  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectedConfig = constructionTypeConfigs.find(
    (entry) => entry.constructionType === constructionType
  );

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

  const toggleFilePick = (id: string) =>
    setPickedFiles((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** 고른 것만 지웁니다. 미리보기 주소도 함께 반납해 메모리를 흘리지 않습니다. */
  const handleRemovePicked = () => {
    setSelectedFiles((prev) => {
      for (const item of prev) {
        if (pickedFiles.has(item.id) && item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      }
      return prev.filter((item) => !pickedFiles.has(item.id));
    });
    setPickedFiles(new Set());
    setErrors((prev) => {
      const copy = { ...prev };
      delete copy.files;
      return copy;
    });
  };

  const handleRemoveFile = (id: string) => {
    setPickedFiles((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
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
    setPickedFiles(new Set());
    setErrors((prev) => {
      const copy = { ...prev };
      delete copy.files;
      return copy;
    });
  };

  const validateForm = (): boolean => {
    const errs: typeof errors = {};

    if (technicianIds.length === 0) {
      errs.technicians = '시공기사를 1명 이상 선택해 주세요.';
    }

    if (!constructionType) {
      errs.constructionType = '시공종류를 선택해 주세요.';
    }
    for (const field of selectedConfig?.fields || []) {
      if (field.required && !(fieldValues[field.id] || '').trim()) {
        errs.customFields = { ...(errs.customFields || {}), [field.id]: `${field.label} 항목을 입력해 주세요.` };
      }
    }

    if (!workOrder && !manualEntry) {
      errs.address = '시공건을 목록에서 선택해 주세요.';
    } else if (!address.trim()) {
      errs.address = '현장 주소를 입력해 주세요.';
    }

    // 직접 입력일 때만 필수입니다. 목록에서 고른 건은 주문서에 적힌 주문자를
    // 그대로 쓰므로 다시 물을 이유가 없고, 직접 입력한 현장은 주문자명이
    // 없으면 나중에 어느 건인지 특정할 방법이 사라집니다.
    if (manualEntry && !workOrder && !customerName.trim()) {
      errs.customerName = '주문자명을 입력해 주세요.';
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

  /**
   * 목록에서 고른 값을 폼에 채웁니다.
   *
   * 서버도 같은 일을 한 번 더 합니다 — 여기서 채운 값은 화면에 보여 주기 위한
   * 것이고, 실제로 저장되는 주소·날짜는 서버가 시공건에서 다시 읽습니다.
   * 브라우저가 보낸 값을 믿으면 목록으로 오타를 없앤 의미가 사라집니다.
   */
  const chooseWorkOrder = (order: WorkOrder) => {
    setWorkOrder(order);
    setManualEntry(false);
    setAddress(order.address);
    setCustomerName(order.customerName || '');
    setConstructionDate(order.scheduledDate);
    setErrors((prev) => ({ ...prev, address: undefined, constructionDate: undefined }));
  };

  const clearWorkOrder = () => {
    setWorkOrder(null);
    setAddress('');
    setCustomerName('');
    setConstructionDate(getTodayString());
  };

  /** 이 시공종류의 입력 항목 차례. 정해 두지 않았으면 기본 차례. */
  const submissionOrder = submissionOrders[constructionType] ?? DEFAULT_SUBMISSION_ORDER;

  /** 직접 입력 중일 때만 나오는 항목인지. */
  const manualOnly = manualEntry && !workOrder;

  /**
   * 목록을 한 단계 더 좁힐 현장종류.
   *
   * 업체별 입력 항목 중 폴더 토큰이 현장종류인 칸의 값입니다. 이름이 아니라
   * 토큰으로 찾는 이유는, 라벨은 업체가 자유롭게 바꾸지만 토큰은 폴더 규칙이
   * 참조하므로 바뀌지 않기 때문입니다.
   */
  const siteTypeField = (selectedConfig?.fields || []).find(
    (field) => field.token === '현장종류' || field.token === 'siteType' || field.label === '현장종류'
  );
  const pickedSiteType = fieldValues[siteTypeField?.id ?? ''] || '';

  /**
   * 현장종류를 아직 고르지 않아 뒷 항목을 감춰 두는 중인지.
   *
   * 한 시공종류 안에서도 현장(거래처)마다 주문건 목록이 완전히 다릅니다.
   * 현장종류를 정하지 않은 채 날짜와 목록을 먼저 펼치면, 기사는 남의 현장까지
   * 섞인 목록을 훑게 되고 그 상태에서 고른 건은 대개 틀립니다. 그래서 이
   * 한 칸을 먼저 받고, 정해진 뒤에 나머지를 엽니다.
   *
   * 현장종류 항목 자체가 없는 업체(단일 현장)는 감출 것이 없으므로 바로
   * 전부 보여 줍니다.
   */
  const waitingForSiteType = Boolean(siteTypeField) && !pickedSiteType;

  /** 각 입력 항목. 그리는 차례는 설정이 정하므로 여기서는 순서를 갖지 않습니다. */
  const section: Record<SubmissionFieldKey, React.ReactNode> = {
    /* 시공종류 — 고정 목록에서 고릅니다. 이 값이 문서 라이브러리의 폴더 이름이
       되기 때문에 손으로 치게 두지 않습니다. */
    constructionType: (
      <div>
        <label className="block text-sm font-semibold text-slate-800 mb-1.5">
          시공종류 <span className="text-rose-500">*</span>
        </label>
        <ConstructionTypePicker
          types={constructionTypes}
          value={constructionType}
          onChange={(type) => {
            setConstructionType(type);
            setFieldValues({});
            setErrors((prev) => ({ ...prev, constructionType: undefined }));
            // 시공건은 시공종류에 매여 있으므로 함께 비웁니다.
            setWorkOrder(null);
            setManualEntry(false);
          }}
          disabled={isSubmitting}
          hasError={Boolean(errors.constructionType)}
        />
        {errors.constructionType && (
          <p className="mt-1.5 text-xs text-rose-600 flex items-center gap-1">
            <AlertTriangle className="w-3.5 h-3.5" />
            {errors.constructionType}
          </p>
        )}
      </div>
    ),

    /* 현장종류를 비롯한 업체별 입력 항목. */
    siteFields: (
      <>
        {(selectedConfig?.fields || []).map((field) => {
          const fieldError = errors.customFields?.[field.id];
          return (
            <div key={field.id}>
              <label className="block text-sm font-semibold text-slate-800 mb-1.5">
                {field.label} {field.required && <span className="text-rose-500">*</span>}
              </label>
              {field.inputType === 'select' ? (
                <ConstructionTypePicker
                  types={field.options}
                  value={fieldValues[field.id] || ''}
                  onChange={(value) => {
                    setFieldValues((current) => ({ ...current, [field.id]: value }));
                    setErrors((current) => ({ ...current, customFields: { ...(current.customFields || {}), [field.id]: '' } }));
                  }}
                  disabled={isSubmitting}
                  hasError={Boolean(fieldError)}
                  placeholder={`${field.label} 검색`}
                  emptyMessage={`등록된 ${field.label} 선택값이 없습니다.`}
                />
              ) : (
                <input
                  type="text"
                  value={fieldValues[field.id] || ''}
                  onChange={(event) => {
                    setFieldValues((current) => ({ ...current, [field.id]: event.target.value }));
                    setErrors((current) => ({ ...current, customFields: { ...(current.customFields || {}), [field.id]: '' } }));
                  }}
                  placeholder={`${field.label} 입력`}
                  disabled={isSubmitting}
                  className={`w-full px-4 py-2.5 rounded-lg border text-base sm:text-sm focus:outline-hidden focus:ring-2 ${fieldError ? 'border-rose-300 focus:ring-rose-200' : 'border-slate-300 focus:border-blue-500 focus:ring-blue-100'}`}
                />
              )}
              {fieldError && <p className="mt-1.5 text-xs text-rose-600">{fieldError}</p>}
            </div>
          );
        })}
      </>
    ),

    /* 목록을 거를 시공일. 실제로 저장되는 시공일은 고른 주문건에서 옵니다. */
    // 달력 방식에서는 날짜를 달력에서 고르므로 이 칸이 필요 없습니다.
    pickDate: workOrder || manualEntry || pickerMode === 'calendar' ? null : (
      <div>
        <label className="block text-sm font-semibold text-slate-800 mb-1.5">시공일</label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={pickDate}
            onChange={(event) => setPickDate(event.target.value)}
            className="flex-1 min-w-[150px] px-3 py-2.5 rounded-lg border border-slate-300 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            type="button"
            onClick={() => setPickDate('')}
            className={`px-3 py-2.5 rounded-lg border text-xs font-semibold ${
              pickDate ? 'border-slate-300 text-slate-600' : 'border-blue-400 bg-blue-50 text-blue-700'
            }`}
          >
            전체 날짜
          </button>
        </div>
      </div>
    ),

    /* 그 날짜의 주문건 목록. */
    workOrder: (
      <div>
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <label className="block text-sm font-semibold text-slate-800">
            시공건 선택 <span className="text-rose-500">*</span>
          </label>
          {/* 고르는 방식은 사람마다 갈립니다 — 날짜로 기억하는 기사와 현장
              이름으로 기억하는 기사가 있어서, 한쪽으로 정해 주면 나머지
              절반이 매번 헤맵니다. */}
          {!workOrder && !manualEntry && (
            <div className="flex rounded-lg border border-slate-300 overflow-hidden text-xs font-bold">
              {([
                ['list', '목록'],
                ['calendar', '달력'],
              ] as const).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setPickerMode(mode)}
                  className={`px-2.5 py-1.5 ${
                    pickerMode === mode ? 'bg-blue-600 text-white' : 'text-slate-600'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
        {manualEntry && !workOrder ? (
          <div className="flex items-center gap-2 p-3 rounded-xl border border-amber-200 bg-amber-50 text-xs text-amber-800">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span className="flex-1">
              목록에 없는 현장으로 직접 입력하는 중입니다. 아래 주문자명·현장주소를 채워 주세요.
            </span>
            <button
              type="button"
              onClick={() => setManualEntry(false)}
              className="shrink-0 px-2.5 py-1.5 rounded-lg border border-amber-300 bg-white font-bold"
            >
              목록으로
            </button>
          </div>
        ) : pickerMode === 'calendar' ? (
          <WorkOrderCalendarPicker
            constructionType={constructionType}
            siteType={pickedSiteType}
            selected={workOrder}
            onSelect={chooseWorkOrder}
            onClear={clearWorkOrder}
            onManualEntry={() => {
              setManualEntry(true);
              clearWorkOrder();
            }}
          />
        ) : (
          <WorkOrderPicker
            constructionType={constructionType}
            siteType={pickedSiteType}
            scheduledDate={pickDate}
            selected={workOrder}
            onSelect={chooseWorkOrder}
            onClear={clearWorkOrder}
            onManualEntry={() => {
              setManualEntry(true);
              clearWorkOrder();
            }}
          />
        )}
        {errors.address && !workOrder && !manualEntry && (
          <p className="mt-1.5 text-xs text-rose-600 flex items-center gap-1">
            <AlertTriangle className="w-3.5 h-3.5" />
            {errors.address}
          </p>
        )}
      </div>
    ),

    /* 실제로 다녀온 기사. 주문서의 예정 기사와 달라도 됩니다. */
    technicians: (
      <div>
        <label className="block text-sm font-semibold text-slate-800 mb-1.5">
          시공기사 <span className="text-rose-500">*</span>
          <span className="ml-1.5 text-xs font-normal text-slate-400">(여러 명 선택 가능)</span>
        </label>
        {workOrder?.technicianName && (
          <p className="mb-1.5 text-xs text-slate-500">
            주문서 예정 기사: <strong className="text-slate-700">{workOrder.technicianName}</strong>
            <span className="ml-1 text-slate-400">— 실제로 간 기사가 달라도 됩니다.</span>
          </p>
        )}
        <TechnicianPicker
          technicians={technicians}
          expectedName={workOrder?.technicianName}
          selectedIds={technicianIds}
          onChange={(ids) => {
            setTechnicianIds(ids);
            if (errors.technicians) {
              setErrors((prev) => ({ ...prev, technicians: undefined }));
            }
          }}
          disabled={isSubmitting}
          hasError={Boolean(errors.technicians)}
        />
        {errors.technicians && (
          <p className="mt-1.5 text-xs text-rose-600 flex items-center gap-1">
            <AlertTriangle className="w-3.5 h-3.5" />
            {errors.technicians}
          </p>
        )}
      </div>
    ),

    /* 아래 셋은 직접 입력일 때만 나옵니다. 주문건을 골랐으면 그 값이 이미
       정확하고, 같은 것을 다시 묻는 칸이 있으면 표기가 갈라집니다. */
    customerName: !manualOnly ? null : (
      <div>
        <label htmlFor="input-customer" className="block text-sm font-semibold text-slate-800 mb-1.5">
          주문자명 <span className="text-rose-500">*</span>
        </label>
        <input
          id="input-customer"
          type="text"
          value={customerName}
          onChange={(event) => {
            setCustomerName(event.target.value);
            if (errors.customerName) setErrors((prev) => ({ ...prev, customerName: undefined }));
          }}
          placeholder="예: 홍길동"
          disabled={isSubmitting}
          className={`w-full px-4 py-2.5 rounded-lg border text-base sm:text-sm focus:outline-hidden focus:ring-2 ${
            errors.customerName
              ? 'border-rose-300 focus:ring-rose-200 bg-rose-50/30'
              : 'border-slate-300 focus:border-blue-500 focus:ring-blue-100'
          }`}
        />
        {errors.customerName && (
          <p className="mt-1.5 text-xs text-rose-600 flex items-center gap-1">
            <AlertTriangle className="w-3.5 h-3.5" />
            {errors.customerName}
          </p>
        )}
      </div>
    ),

    address: !manualOnly ? null : (
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
              if (errors.address) setErrors((prev) => ({ ...prev, address: undefined }));
            }}
            placeholder="예: 경기 광명시 하안로 60 광명SK테크노파크 A동 702호"
            className={`w-full pl-10 pr-4 py-2.5 rounded-lg border text-base sm:text-sm focus:outline-hidden focus:ring-2 transition-all ${
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
    ),

    constructionDate: !manualOnly ? null : (
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label htmlFor="input-construction-date" className="block text-sm font-semibold text-slate-800">
            시공일 <span className="text-rose-500">*</span>
          </label>
          <button
            type="button"
            onClick={() => setDatePreset(-1)}
            className="text-xs px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-md transition-colors font-medium"
          >
            어제 날짜로
          </button>
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
              if (errors.constructionDate) setErrors((prev) => ({ ...prev, constructionDate: undefined }));
            }}
            className={`w-full pl-10 pr-4 py-2.5 rounded-lg border text-base sm:text-sm focus:outline-hidden focus:ring-2 transition-all ${
              errors.constructionDate
                ? 'border-rose-300 focus:ring-rose-200 bg-rose-50/30'
                : 'border-slate-300 focus:border-blue-500 focus:ring-blue-100'
            }`}
            disabled={isSubmitting}
          />
        </div>
        {errors.constructionDate && (
          <p className="mt-1.5 text-xs text-rose-600 flex items-center gap-1">
            <AlertTriangle className="w-3.5 h-3.5" />
            {errors.constructionDate}
          </p>
        )}
      </div>
    ),

    notes: (
      <div>
        <label htmlFor="textarea-notes" className="block text-sm font-semibold text-slate-800 mb-1.5">
          특이사항 <span className="text-xs text-slate-400 font-normal">(선택 입력)</span>
        </label>
        <textarea
          id="textarea-notes"
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="예: 싱크대 상판 자재를 현장에서 변경함"
          className="w-full px-4 py-2.5 rounded-lg border border-slate-300 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 text-base sm:text-sm focus:outline-hidden transition-all"
          disabled={isSubmitting}
        />
      </div>
    ),
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
      fieldValues,
      technicianIds,
      address: address.trim(),
      constructionDate,
      notes: notes.trim(),
      customerName: customerName.trim(),
      files: selectedFiles.map((item) => item.file),
      workOrderId: workOrder?.id || '',
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
              <HardHat className="w-5 h-5 text-blue-600" />
              현장 기본 정보
            </h3>
            <span className="text-xs text-rose-600 font-medium">* 필수 입력 항목</span>
          </div>

          {/* 항목 차례는 설정에서 정합니다. 왜 순서를 코드에 박지 않는지는
              submission-layout.ts 에 적어 두었습니다. */}
          <div className="space-y-5">
            {section.constructionType}
            {constructionType &&
              submissionOrder
                .filter((key: SubmissionFieldKey) => key !== 'constructionType')
                // 현장종류를 고르기 전에는 그 칸까지만 보여 줍니다.
                .filter((key: SubmissionFieldKey) => !waitingForSiteType || key === 'siteFields')
                .map((key: SubmissionFieldKey) => (
                  <React.Fragment key={key}>{section[key]}</React.Fragment>
                ))}

            {waitingForSiteType && (
              <p className="flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs text-slate-600">
                <Info className="w-4 h-4 shrink-0 mt-0.5 text-slate-400" />
                <span>
                  <strong>{siteTypeField?.label || '현장종류'}</strong>를 고르면 나머지 입력
                  항목과 그 현장의 시공건 목록이 나옵니다.
                </span>
              </p>
            )}
          </div>
        </div>

        {constructionType && !waitingForSiteType && <>
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
              <div className="flex items-center justify-between mb-2 text-xs text-slate-600">
                <span className="font-semibold text-slate-800">
                  첨부 목록 (사진 {photoCount}개, 영상 {videoCount}개, 총 {formatBytes(totalSizeBytes)})
                </span>
                <span>{selectedFiles.length}개 파일 준비됨</span>
              </div>

              {/*
               * 골라서 지우기.
               *
               * 낱개 삭제만 있으면 잘못 고른 사진 열 장을 지우는 데 열 번을
               * 눌러야 하고, 그 사이 목록이 계속 밀려서 엉뚱한 것을 지우게
               * 됩니다. 현장에서 장갑 낀 손으로 하는 일이라 더 그렇습니다.
               */}
              <div className="flex flex-wrap items-center gap-2 mb-3">
                <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600">
                  <input
                    type="checkbox"
                    checked={pickedFiles.size > 0 && pickedFiles.size === selectedFiles.length}
                    ref={(node) => {
                      if (node) {
                        node.indeterminate =
                          pickedFiles.size > 0 && pickedFiles.size < selectedFiles.length;
                      }
                    }}
                    onChange={() =>
                      setPickedFiles(
                        pickedFiles.size === selectedFiles.length
                          ? new Set()
                          : new Set(selectedFiles.map((item) => item.id))
                      )
                    }
                    className="w-4 h-4 accent-blue-600"
                  />
                  전체 선택
                </label>

                {pickedFiles.size > 0 && (
                  <>
                    <span className="text-xs font-bold text-blue-700">{pickedFiles.size}개 선택됨</span>
                    <button
                      type="button"
                      onClick={handleRemovePicked}
                      disabled={isSubmitting}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-rose-600 text-white text-xs font-bold disabled:opacity-40"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      선택 삭제
                    </button>
                    <button
                      type="button"
                      onClick={() => setPickedFiles(new Set())}
                      className="px-2 py-1.5 text-xs font-semibold text-slate-500 underline"
                    >
                      선택 해제
                    </button>
                  </>
                )}
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 max-h-96 overflow-y-auto p-1">
                {selectedFiles.map((item, index) => {
                  const picked = pickedFiles.has(item.id);
                  return (
                  <div
                    key={item.id}
                    onClick={() => toggleFilePick(item.id)}
                    className={`relative group rounded-lg border-2 bg-white p-2 flex flex-col justify-between shadow-2xs transition-all cursor-pointer ${
                      picked
                        ? 'border-blue-600 ring-2 ring-blue-200'
                        : 'border-slate-200 hover:shadow-xs'
                    }`}
                  >
                    {/* 카드 어디를 눌러도 선택됩니다 — 작은 체크박스만 노려
                        누르게 하면 현장에서 자꾸 빗나갑니다. */}
                    <input
                      type="checkbox"
                      checked={picked}
                      onChange={() => toggleFilePick(item.id)}
                      onClick={(event) => event.stopPropagation()}
                      aria-label={`${item.file.name} 선택`}
                      className="absolute bottom-2 right-2 z-10 w-5 h-5 accent-blue-600"
                    />

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
                  );
                })}
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
        </>}
      </form>
    </div>
  );
};
