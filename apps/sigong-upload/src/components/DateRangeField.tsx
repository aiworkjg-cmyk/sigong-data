import React from 'react';
import { CalendarDays, X } from 'lucide-react';

interface DateRangeFieldProps {
  from: string;
  to: string;
  onChange: (range: { from: string; to: string }) => void;
}

interface Preset {
  label: string;
  resolve: () => { from: string; to: string };
}

function iso(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`;
}

function daysAgo(count: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - count);
  return date;
}

const PRESETS: Preset[] = [
  { label: '오늘', resolve: () => ({ from: iso(new Date()), to: iso(new Date()) }) },
  { label: '최근 7일', resolve: () => ({ from: iso(daysAgo(6)), to: iso(new Date()) }) },
  { label: '최근 30일', resolve: () => ({ from: iso(daysAgo(29)), to: iso(new Date()) }) },
  {
    label: '이번 달',
    resolve: () => {
      const now = new Date();
      return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: iso(now) };
    },
  },
];

/**
 * One control for a whole period, rather than two separate labelled fields.
 *
 * The two native date inputs sit inside a single bordered box joined by "~", so
 * it reads and behaves as one field while still opening the OS date picker —
 * which is what makes it usable on a phone, where most of this traffic is.
 */
export const DateRangeField: React.FC<DateRangeFieldProps> = ({ from, to, onChange }) => {
  const active = Boolean(from || to);

  return (
    <div className="space-y-2">
      <div
        className={`flex items-center gap-1 rounded-lg border px-2.5 py-1.5 bg-white transition-colors ${
          active ? 'border-blue-400 ring-2 ring-blue-100' : 'border-slate-300'
        }`}
      >
        <CalendarDays className="w-4 h-4 text-slate-400 shrink-0" />
        <input
          type="date"
          value={from}
          max={to || undefined}
          onChange={(event) => onChange({ from: event.target.value, to })}
          aria-label="시작일"
          className="min-w-0 flex-1 px-1 py-1 text-sm bg-transparent focus:outline-none"
        />
        <span className="text-slate-400 font-semibold shrink-0">~</span>
        <input
          type="date"
          value={to}
          min={from || undefined}
          onChange={(event) => onChange({ from, to: event.target.value })}
          aria-label="종료일"
          className="min-w-0 flex-1 px-1 py-1 text-sm bg-transparent focus:outline-none"
        />
        {active && (
          <button
            type="button"
            onClick={() => onChange({ from: '', to: '' })}
            className="p-1 rounded hover:bg-slate-100 text-slate-400 shrink-0"
            aria-label="기간 초기화"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            onClick={() => onChange(preset.resolve())}
            className="px-2.5 py-1 rounded-md bg-slate-100 hover:bg-slate-200 text-[11px] font-semibold text-slate-700 transition-colors"
          >
            {preset.label}
          </button>
        ))}
      </div>
    </div>
  );
};
