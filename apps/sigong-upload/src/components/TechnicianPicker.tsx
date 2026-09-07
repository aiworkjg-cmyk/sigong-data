import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, UserPlus, X } from 'lucide-react';
import { matchesQuery } from '../hangul';
import { titleStyle } from '../technicians';
import type { Technician } from '../types';

interface TechnicianPickerProps {
  technicians: Technician[];
  /** Selected roster ids, in the order the user picked them. */
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  hasError?: boolean;
  /**
   * 주문서에 적힌 예정 기사 이름.
   *
   * 대개 이 사람이 실제로 다녀오므로 목록 맨 위에 둡니다. 다만 **거르지는
   * 않습니다** — 예정과 실제가 다른 경우가 흔하고, 걸러 버리면 대신 간 기사가
   * 자기 이름을 찾지 못해 목록을 포기하게 됩니다.
   */
  expectedName?: string;
}

/**
 * Picks one or more 시공기사 from the roster.
 *
 * Free text is deliberately not accepted: the chosen names end up in the record
 * and are what a 시공기사 account matches its own history against, so a typo
 * would quietly detach a submission from the person who did the work.
 *
 * The search box is Hangul-aware (see hangul.ts) because field staff type on a
 * phone — "ㅎ" or "호" has to surface 홍길동 before the syllable is finished.
 */
export const TechnicianPicker: React.FC<TechnicianPickerProps> = ({
  technicians,
  selectedIds,
  onChange,
  disabled,
  hasError,
  expectedName,
}) => {
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () =>
      selectedIds
        .map((id) => technicians.find((tech) => tech.id === id))
        .filter((tech): tech is Technician => Boolean(tech)),
    [selectedIds, technicians]
  );

  /**
   * 주문서의 예정 기사와 같은 사람인지.
   *
   * 주문서에는 "유동현 팀장" 처럼 직함이 붙어 오고 명부에는 이름만 있어서,
   * 정확히 같기를 기대할 수 없습니다. 공백을 지운 뒤 한쪽이 다른 쪽을
   * 포함하는지로 봅니다.
   */
  const isExpected = useCallback(
    (name: string) => {
      const wanted = (expectedName || '').replace(/\s+/g, '');
      const candidate = name.replace(/\s+/g, '');
      if (!wanted || !candidate) return false;
      return wanted.includes(candidate) || candidate.includes(wanted);
    },
    [expectedName]
  );

  const matches = useMemo(
    () =>
      technicians
        .filter((tech) => !selectedIds.includes(tech.id))
        .filter((tech) => matchesQuery(tech.name, query))
        // 예정 기사를 맨 위로. 순서만 바꾸고 아무도 빼지 않습니다.
        .sort((left, right) => Number(isExpected(right.name)) - Number(isExpected(left.name))),
    [technicians, selectedIds, query, isExpected]
  );

  // Keep the highlighted row inside the result list as it shrinks while typing.
  useEffect(() => {
    setHighlight(0);
  }, [query]);

  // Clicking anywhere else closes the dropdown.
  useEffect(() => {
    if (!isOpen) return;

    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
    };
  }, [isOpen]);

  const add = (tech: Technician) => {
    onChange([...selectedIds, tech.id]);
    setQuery('');
    setIsOpen(true);
  };

  const remove = (id: string) => onChange(selectedIds.filter((value) => value !== id));

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // Ignore keys while an IME is mid-composition, or Enter would commit the
    // half-formed syllable instead of choosing a row.
    if (event.nativeEvent.isComposing) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setIsOpen(true);
      setHighlight((prev) => Math.min(prev + 1, matches.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight((prev) => Math.max(prev - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const tech = matches[highlight];
      if (tech) add(tech);
    } else if (event.key === 'Escape') {
      setIsOpen(false);
    } else if (event.key === 'Backspace' && !query && selected.length > 0) {
      remove(selected[selected.length - 1].id);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      {/* Chosen people */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {selected.map((tech) => {
            const style = titleStyle(tech.title);
            return (
              <span
                key={tech.id}
                className={`inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-lg border text-sm font-bold ${style.chip}`}
              >
                {tech.name}
                <span className="text-[11px] font-semibold opacity-80">{tech.title}</span>
                {!disabled && (
                  <button
                    type="button"
                    onClick={() => remove(tech.id)}
                    className="p-0.5 rounded hover:bg-black/10"
                    aria-label={`${tech.name} 선택 해제`}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}

      {/* Search box */}
      <div className="relative">
        <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
          <Search className="w-4 h-4" />
        </div>
        <input
          type="text"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder="예: 홍길동"
          // A phone keyboard should not capitalize or autocorrect a name.
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          className={`w-full pl-10 pr-4 py-2.5 rounded-lg border text-base sm:text-sm focus:outline-hidden focus:ring-2 transition-all ${
            hasError
              ? 'border-rose-300 focus:ring-rose-200 bg-rose-50/30'
              : 'border-slate-300 focus:border-blue-500 focus:ring-blue-100'
          }`}
        />
      </div>

      {/* Results */}
      {isOpen && !disabled && (
        <div className="absolute z-20 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-lg max-h-64 overflow-y-auto">
          {technicians.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-slate-400">
              등록된 시공기사가 없습니다. 관리자에게 명부 등록을 요청해 주세요.
            </p>
          ) : matches.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-slate-400">
              {query ? `"${query}" 검색 결과가 없습니다.` : '모든 기사를 선택했습니다.'}
            </p>
          ) : (
            <ul>
              {matches.map((tech, index) => {
                const style = titleStyle(tech.title);
                return (
                  <li key={tech.id}>
                    <button
                      type="button"
                      onMouseEnter={() => setHighlight(index)}
                      onClick={() => add(tech)}
                      className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors ${
                        index === highlight ? 'bg-blue-50' : 'hover:bg-slate-50'
                      }`}
                    >
                      <span className={`w-1 h-6 rounded-full shrink-0 ${style.accent}`} />
                      <span className="text-sm font-bold text-slate-800 flex-1 truncate">
                        {tech.name}
                        {/* 안내일 뿐이라 연하게 둡니다. 진하게 하면 "이 사람을
                            골라야 한다"로 읽혀, 실제로 간 기사를 고르는 것을
                            망설이게 만듭니다. */}
                        {isExpected(tech.name) && (
                          <span className="ml-1.5 px-1.5 py-0.5 rounded bg-slate-100 text-[10px] font-medium text-slate-500 align-middle">
                            시공예정기사
                          </span>
                        )}
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded-full border text-[11px] font-bold shrink-0 ${style.chip}`}
                      >
                        {tech.title}
                      </span>
                      <UserPlus className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};
