import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { matchesQuery } from '../hangul';
import { typeStyle } from '../constructionTypes';

interface ConstructionTypePickerProps {
  types: string[];
  value: string;
  onChange: (type: string) => void;
  disabled?: boolean;
  hasError?: boolean;
  placeholder?: string;
  emptyMessage?: string;
}

/**
 * Picks one 시공종류 by typing.
 *
 * Same rule as the 시공기사 picker — the value becomes a folder name and the
 * prefix of the 현장 ID, so it is chosen from the configured list rather than
 * typed. Search is Hangul-aware, so "ㅂ" or "배" finds 백조 on a phone keypad.
 */
export const ConstructionTypePicker: React.FC<ConstructionTypePickerProps> = ({
  types,
  value,
  onChange,
  disabled,
  hasError,
  placeholder = '예: 한샘',
  emptyMessage = '등록된 시공종류가 없습니다. 관리자에게 문의해 주세요.',
}) => {
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(
    () => types.filter((type) => matchesQuery(type, query)),
    [types, query]
  );

  useEffect(() => setHighlight(0), [query]);

  useEffect(() => {
    if (!isOpen) return;

    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
    };
  }, [isOpen]);

  const pick = (type: string) => {
    onChange(type);
    setQuery('');
    setIsOpen(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
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
      if (matches[highlight]) pick(matches[highlight]);
    } else if (event.key === 'Escape') {
      setIsOpen(false);
      setQuery('');
    }
  };

  const style = value ? typeStyle(value) : null;

  return (
    <div ref={containerRef} className="relative">
      {value && !isOpen ? (
        // Settled state — the chosen type in its own colour.
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setIsOpen(true);
            setQuery('');
          }}
          className={`w-full flex items-center gap-2 px-3.5 py-2.5 rounded-lg border-2 text-left transition-colors ${style!.selected}`}
        >
          <span className={`w-2 h-5 rounded-full shrink-0 ${style!.accent}`} />
          <span className="flex-1 text-base sm:text-sm font-bold truncate">{value}</span>
          <X
            className="w-4 h-4 opacity-50 hover:opacity-100 shrink-0"
            onClick={(event) => {
              event.stopPropagation();
              onChange('');
            }}
          />
          <ChevronDown className="w-4 h-4 opacity-60 shrink-0" />
        </button>
      ) : (
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
            placeholder={placeholder}
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
      )}

      {isOpen && !disabled && (
        <div className="absolute z-20 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-lg max-h-60 overflow-y-auto">
          {types.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-slate-400">
              {emptyMessage}
            </p>
          ) : matches.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-slate-400">
              &quot;{query}&quot; 검색 결과가 없습니다.
            </p>
          ) : (
            <ul>
              {matches.map((type, index) => {
                const itemStyle = typeStyle(type);
                const chosen = type === value;
                return (
                  <li key={type}>
                    <button
                      type="button"
                      onMouseEnter={() => setHighlight(index)}
                      onClick={() => pick(type)}
                      className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors ${
                        index === highlight ? 'bg-slate-50' : 'hover:bg-slate-50'
                      }`}
                    >
                      <span className={`w-1.5 h-6 rounded-full shrink-0 ${itemStyle.accent}`} />
                      <span
                        className={`px-2 py-0.5 rounded-md border text-sm font-bold ${itemStyle.chip}`}
                      >
                        {type}
                      </span>
                      <span className="flex-1" />
                      {chosen && <Check className="w-4 h-4 text-blue-600 shrink-0" />}
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
