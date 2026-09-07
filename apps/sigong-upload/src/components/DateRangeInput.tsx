import React, { useEffect, useRef, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';

interface DateRangeInputProps {
  from: string;
  to: string;
  onChange: (range: { from: string; to: string }) => void;
  /** 기간 버튼(오늘·이번 주…)을 함께 보여줄지. 좁은 자리에서는 끕니다. */
  presets?: boolean;
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const iso = (date: Date) => date.toISOString().slice(0, 10);

function addMonths(month: string, delta: number): string {
  const [year, m] = month.split('-').map(Number);
  return iso(new Date(Date.UTC(year ?? 2026, (m ?? 1) - 1 + delta, 1))).slice(0, 7);
}

/** 그 달의 칸들. 앞은 빈칸으로 채워 요일을 맞춥니다. */
function monthCells(month: string): Array<string | null> {
  const [year, m] = month.split('-').map(Number);
  const first = new Date(Date.UTC(year ?? 2026, (m ?? 1) - 1, 1));
  const days = new Date(Date.UTC(year ?? 2026, m ?? 1, 0)).getUTCDate();
  return [
    ...Array.from({ length: first.getUTCDay() }, () => null),
    ...Array.from({ length: days }, (_, index) =>
      iso(new Date(Date.UTC(year ?? 2026, (m ?? 1) - 1, index + 1)))
    ),
  ];
}

/** 세 조각이 모두 채워졌고 실제로 존재하는 날짜일 때만 값이 됩니다. */
function joinParts(year: string, month: string, day: string): string | null {
  if (year.length !== 4 || !month || !day) return null;
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!(y >= 2000 && y <= 2100) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  // 2월 31일 같은 값을 3월 3일로 조용히 바꾸지 않습니다.
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? iso(date) : null;
}

type Segment = { value: string; size: 4 | 2; placeholder: string; max: number };

const EMPTY_PARTS: string[] = ['', '', '', '', '', ''];

/** "2026-08-01" → ["2026","08","01"] */
function splitDate(value: string): [string, string, string] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  return match ? [match[1]!, match[2]!, match[3]!] : ['', '', ''];
}

/**
 * 기간 하나를 한 줄에서 지정합니다.
 *
 * 연·월·일을 각각의 칸으로 나눈 이유: 한 덩어리 텍스트 칸은 고쳐야 할 때
 * 전체를 지우고 다시 치게 만듭니다. 월만 바꾸고 싶은 경우가 대부분인데도요.
 * 칸을 나누면 그 자리만 눌러 고칠 수 있고, 다 채우면 다음 칸으로 자동으로
 * 넘어가서 연속으로 타이핑하는 흐름도 끊기지 않습니다.
 *
 * 달력 아이콘은 같은 값을 다른 방식으로 고르는 길입니다 — 두 번 눌러 범위를
 * 잡고, 한 번만 누르고 닫으면 그 하루입니다.
 */
export const DateRangeInput: React.FC<DateRangeInputProps> = ({
  from,
  to,
  onChange,
  presets = false,
}) => {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => (from || iso(new Date())).slice(0, 7));
  /** 달력에서 첫 번째 날짜를 누른 뒤 두 번째를 기다리는 상태. */
  const [anchor, setAnchor] = useState('');
  const [hover, setHover] = useState('');
  /** 입력 중인 조각들. 확정 전에는 부모 값과 다를 수 있습니다. */
  const [parts, setParts] = useState<string[]>(EMPTY_PARTS);
  const box = useRef<HTMLDivElement>(null);
  const inputs = useRef<Array<HTMLInputElement | null>>([]);

  /**
   * 방금 우리가 올려보낸 값. 바깥에서 온 변경과 구분하기 위한 것입니다.
   *
   * 이게 없으면 시작일을 다 치는 순간 commit 이 from=to 로 올리고, 그 값이
   * 다시 내려와 종료일 칸을 시작일로 덮어씁니다 — 종료일을 아예 칠 수 없게
   * 됩니다. 실제로 그렇게 깨져 있었습니다.
   */
  const lastCommitted = useRef('');

  // 바깥에서 값이 바뀔 때만(전체보기·기간 버튼·달력) 조각을 다시 맞춥니다.
  useEffect(() => {
    if (lastCommitted.current === `${from}|${to}`) return;
    setParts([...splitDate(from), ...splitDate(to)]);
  }, [from, to]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) {
        setOpen(false);
        setAnchor('');
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  /** 여섯 조각에서 기간을 만들어 부모에게 올립니다. */
  const commit = (next: string[]) => {
    const start = joinParts(next[0]!, next[1]!, next[2]!);
    const end = joinParts(next[3]!, next[4]!, next[5]!);

    const push = (range: { from: string; to: string }) => {
      lastCommitted.current = `${range.from}|${range.to}`;
      if (range.from !== from || range.to !== to) onChange(range);
    };

    if (!start && !end) {
      push({ from: '', to: '' });
      return;
    }
    // 한쪽만 채우면 그 하루만 조회합니다. 종료일을 치는 중일 수 있으므로,
    // 시작일만 있는 상태를 "그 하루" 로 확정해도 조각은 그대로 둡니다.
    const low = start ?? end!;
    const high = end ?? start!;
    push(low <= high ? { from: low, to: high } : { from: high, to: low });
  };

  const setPart = (index: number, raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, index % 3 === 0 ? 4 : 2);
    const next = parts.map((value, position) => (position === index ? digits : value));
    setParts(next);

    // 다 채우면 다음 칸으로. 연속 타이핑이 끊기지 않게 하는 부분입니다.
    const size = index % 3 === 0 ? 4 : 2;
    if (digits.length === size && index < 5) inputs.current[index + 1]?.focus();
    commit(next);
  };

  const onKey = (index: number) => (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace' && !parts[index] && index > 0) {
      event.preventDefault();
      inputs.current[index - 1]?.focus();
    }
    // 위·아래로 값 조정 — 달력을 열지 않고 하루씩 옮길 때 씁니다.
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const size = index % 3 === 0 ? 4 : 2;
      const current = Number(parts[index] || (index % 3 === 0 ? '2026' : '1'));
      const delta = event.key === 'ArrowUp' ? 1 : -1;
      setPart(index, String(Math.max(current + delta, 0)).padStart(size, '0'));
    }
  };

  const segments: Segment[] = [
    { value: parts[0]!, size: 4, placeholder: 'YYYY', max: 2100 },
    { value: parts[1]!, size: 2, placeholder: 'MM', max: 12 },
    { value: parts[2]!, size: 2, placeholder: 'DD', max: 31 },
    { value: parts[3]!, size: 4, placeholder: 'YYYY', max: 2100 },
    { value: parts[4]!, size: 2, placeholder: 'MM', max: 12 },
    { value: parts[5]!, size: 2, placeholder: 'DD', max: 31 },
  ];

  const pick = (day: string) => {
    // 달력에서 고른 값은 조각 칸에도 그대로 보여야 하므로, 여기서는 표시를
    // 남기지 않습니다 — useEffect 가 props 를 읽어 칸을 채우게 둡니다.
    if (!anchor) {
      setAnchor(day);
      // 첫 클릭에서 바로 그 하루로 적용합니다 — 한 번만 누르고 닫아도 되도록.
      onChange({ from: day, to: day });
      return;
    }
    onChange(anchor <= day ? { from: anchor, to: day } : { from: day, to: anchor });
    setAnchor('');
    setOpen(false);
  };

  const inRange = (day: string) => {
    if (anchor && hover) {
      const [low, high] = anchor <= hover ? [anchor, hover] : [hover, anchor];
      return day >= low && day <= high;
    }
    return Boolean(from && to && day >= from && day <= to);
  };

  const applyPreset = (range: { from: string; to: string }) => {
    onChange(range);
    setMonth(range.from.slice(0, 7));
  };

  const today = new Date();
  const presetList = [
    { label: '오늘', from: iso(today), to: iso(today) },
    {
      label: '이번 주',
      from: iso(new Date(today.getTime() - ((today.getDay() + 6) % 7) * 86400000)),
      to: iso(today),
    },
    { label: '이번 달', from: `${iso(today).slice(0, 7)}-01`, to: iso(today) },
  ];

  const segment = (index: number) => {
    const item = segments[index]!;
    return (
      <input
        ref={(element) => { inputs.current[index] = element; }}
        value={item.value}
        onChange={(event) => setPart(index, event.target.value)}
        onKeyDown={onKey(index)}
        onFocus={(event) => event.target.select()}
        placeholder={item.placeholder}
        inputMode="numeric"
        // 16px 미만이면 iOS 가 포커스 시 화면을 확대합니다.
        className={`${item.size === 4 ? 'w-9' : 'w-6'} text-center text-xs bg-transparent focus:outline-none focus:bg-blue-50 rounded`}
        aria-label={`${index < 3 ? '시작' : '종료'} ${item.placeholder}`}
      />
    );
  };

  return (
    <div ref={box} className="relative inline-block">
      <div className="flex items-center gap-0.5 rounded-lg border border-slate-300 bg-white px-1.5 py-1.5">
        <button
          type="button"
          onClick={() => {
            setOpen(!open);
            setAnchor('');
            if (from) setMonth(from.slice(0, 7));
          }}
          className={`px-1 ${open ? 'text-blue-600' : 'text-slate-400'} hover:text-blue-600`}
          aria-label="달력에서 고르기"
        >
          <CalendarDays className="w-4 h-4" />
        </button>

        {segment(0)}
        <span className="text-slate-300">-</span>
        {segment(1)}
        <span className="text-slate-300">-</span>
        {segment(2)}
        <span className="mx-1 text-slate-400 font-semibold">~</span>
        {segment(3)}
        <span className="text-slate-300">-</span>
        {segment(4)}
        <span className="text-slate-300">-</span>
        {segment(5)}

        {(from || to) && (
          <button
            type="button"
            onClick={() => onChange({ from: '', to: '' })}
            className="ml-0.5 px-0.5 text-slate-400 hover:text-slate-700"
            aria-label="기간 지우기"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {open && (
        <div className="absolute z-30 mt-1 p-3 rounded-xl border border-slate-200 bg-white shadow-lg">
          {presets && (
            <div className="flex flex-wrap gap-1 mb-2 pb-2 border-b border-slate-100">
              {presetList.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => applyPreset(preset)}
                  className="px-2 py-1 rounded-md bg-slate-100 hover:bg-slate-200 text-[11px] font-semibold text-slate-700"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center justify-between mb-2">
            <button
              type="button"
              onClick={() => setMonth(addMonths(month, -1))}
              className="p-1 rounded text-slate-500 hover:bg-slate-100"
              aria-label="이전 달"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-xs font-bold text-slate-800">{month.replace('-', '년 ')}월</span>
            <button
              type="button"
              onClick={() => setMonth(addMonths(month, 1))}
              className="p-1 rounded text-slate-500 hover:bg-slate-100"
              aria-label="다음 달"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-0.5 mb-1">
            {WEEKDAYS.map((label, index) => (
              <div
                key={label}
                className={`w-8 text-center text-[10px] font-bold ${
                  index === 0 ? 'text-rose-400' : index === 6 ? 'text-blue-400' : 'text-slate-400'
                }`}
              >
                {label}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-0.5">
            {monthCells(month).map((day, index) =>
              day === null ? (
                <div key={`gap-${index}`} className="w-8 h-8" />
              ) : (
                <button
                  key={day}
                  type="button"
                  onClick={() => pick(day)}
                  onMouseEnter={() => setHover(day)}
                  className={`w-8 h-8 rounded text-xs font-semibold ${
                    day === from || day === to || day === anchor
                      ? 'bg-blue-600 text-white'
                      : inRange(day)
                        ? 'bg-blue-100 text-blue-900'
                        : 'text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  {Number(day.slice(8))}
                </button>
              )
            )}
          </div>

          <p className="mt-2 text-[10px] text-slate-400">
            {anchor ? '끝나는 날짜를 골라 주세요' : '한 번만 누르면 그 하루만 조회합니다'}
          </p>
        </div>
      )}
    </div>
  );
};
