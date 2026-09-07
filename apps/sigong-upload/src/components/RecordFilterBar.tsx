import React from 'react';
import { Download, RotateCcw } from 'lucide-react';
import { DateRangeInput } from './DateRangeInput';
import { REGION_GROUPS } from '../types';

export interface RecordFilters {
  /** YYYY / YYYY-MM / YYYY-MM-DD 중 하나. 앞부분만 비교하므로 셋 다 됩니다. */
  from: string;
  to: string;
  constructionType: string;
  technician: string;
  regionGroup: string;
}

export const EMPTY_FILTERS: RecordFilters = {
  from: '', to: '', constructionType: '', technician: '', regionGroup: '',
};

interface RecordFilterBarProps {
  value: RecordFilters;
  onChange: (next: RecordFilters) => void;
  /** 실제 데이터에 등장한 값들. 고를 수 없는 선택지는 보여 주지 않습니다. */
  constructionTypes: string[];
  technicians: string[];
  /** 필터 적용 후 남은 건수 / 전체. */
  matched: number;
  total: number;
  /** 지금 보이는 목록을 엑셀로 내려받습니다. 없으면 버튼이 안 나옵니다. */
  onExport?: () => void;
}

/** 오늘 · 이번 주 · 이번 달 — 실제로 매번 누르는 것만 둡니다. */
function presets(): Array<{ label: string; from: string; to: string }> {
  const now = new Date();
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  const monday = new Date(now);
  // 주 시작은 월요일. 시공 일정이 주 단위로 잡히기 때문입니다.
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));

  return [
    { label: '오늘', from: iso(now), to: iso(now) },
    { label: '이번 주', from: iso(monday), to: iso(now) },
    { label: '이번 달', from: `${iso(now).slice(0, 7)}-01`, to: iso(now) },
  ];
}

/**
 * 현장 목록과 업로드 로그가 함께 쓰는 필터.
 *
 * 두 화면이 답하는 질문이 같기 때문에 하나로 만들었습니다 — "지난달 백조,
 * 수도권, 유동현 팀장 건". 화면마다 필터를 따로 만들면 하나에만 조건이 생기고
 * 다른 하나는 뒤처집니다. 실제로 그렇게 되어 있었습니다.
 */
export const RecordFilterBar: React.FC<RecordFilterBarProps> = ({
  value,
  onChange,
  constructionTypes,
  technicians,
  matched,
  total,
  onExport,
}) => {
  const set = (patch: Partial<RecordFilters>) => onChange({ ...value, ...patch });
  const active = JSON.stringify(value) !== JSON.stringify(EMPTY_FILTERS);

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 mb-4">
      <div className="flex flex-wrap items-center gap-1.5 mb-2">
        {presets().map((preset) => {
          const on = value.from === preset.from && value.to === preset.to;
          return (
            <button
              key={preset.label}
              type="button"
              onClick={() => set(on ? { from: '', to: '' } : { from: preset.from, to: preset.to })}
              className={`px-2.5 py-1.5 rounded-lg border text-xs font-bold ${
                on ? 'border-blue-500 bg-blue-600 text-white' : 'border-slate-300 text-slate-600'
              }`}
            >
              {preset.label}
            </button>
          );
        })}
        <span className="mx-1 text-slate-300">|</span>
        <DateRangeInput
          from={value.from}
          to={value.to}
          onChange={(range) => set(range)}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={value.constructionType}
          onChange={(event) => set({ constructionType: event.target.value })}
          className="px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs"
        >
          <option value="">전체 업체</option>
          {constructionTypes.map((type) => (
            <option key={type} value={type}>{type}</option>
          ))}
        </select>

        <select
          value={value.technician}
          onChange={(event) => set({ technician: event.target.value })}
          className="px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs"
        >
          <option value="">전체 기사</option>
          {technicians.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>

        <select
          value={value.regionGroup}
          onChange={(event) => set({ regionGroup: event.target.value })}
          className="px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs"
        >
          <option value="">전체 지역</option>
          {REGION_GROUPS.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>

        {active && (
          <button
            type="button"
            onClick={() => onChange(EMPTY_FILTERS)}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs font-semibold text-slate-600"
          >
            <RotateCcw className="w-3 h-3" />
            전체보기
          </button>
        )}

        <span className="ml-auto text-[11px] font-semibold text-slate-500">
          {matched}건{matched !== total && ` / 전체 ${total}건`}
        </span>

        {onExport && (
          <button
            type="button"
            onClick={onExport}
            disabled={matched === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" />
            엑셀 받기
          </button>
        )}
      </div>
    </div>
  );
};

/**
 * 한 건이 필터를 통과하는지.
 *
 * 날짜는 문자열 앞부분 비교입니다 — YYYY / YYYY-MM / YYYY-MM-DD 어느 정밀도로
 * 넣어도 같은 코드가 동작하고, 시간대 변환이 끼어들 여지가 없습니다.
 */
export function matchesFilters(
  filters: RecordFilters,
  record: {
    date: string;
    constructionType: string;
    /** 여러 명일 수 있으므로 합친 문자열로 받습니다. */
    technicians: string;
    regionGroup: string;
  }
): boolean {
  if (filters.from && record.date < filters.from) return false;
  // to 는 그 날을 포함해야 하므로, 날짜만 비교되도록 앞부분을 자릅니다.
  if (filters.to && record.date.slice(0, filters.to.length) > filters.to) return false;
  if (filters.constructionType && record.constructionType !== filters.constructionType) return false;
  if (filters.technician && !record.technicians.includes(filters.technician)) return false;
  if (filters.regionGroup && record.regionGroup !== filters.regionGroup) return false;
  return true;
}
