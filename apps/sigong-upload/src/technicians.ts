import type { TechnicianTitle } from './types';

/**
 * Pastel palette for the 직함.
 *
 * Titles have to be readable at a glance on a phone in daylight, so each one
 * gets its own hue rather than a shared grey chip. The tones are kept light and
 * of similar weight so no single title reads as more urgent than the others —
 * this is a category, not a status.
 */
export interface TitleStyle {
  /** Chip used in lists and on the submission form. */
  chip: string;
  /** Left accent bar for roster rows. */
  accent: string;
  /** Selected state for the picker. */
  selected: string;
}

export const TITLE_STYLES: Record<TechnicianTitle, TitleStyle> = {
  대표: {
    chip: 'bg-rose-100 text-rose-800 border-rose-200',
    accent: 'bg-rose-300',
    selected: 'border-rose-400 bg-rose-50',
  },
  실장: {
    chip: 'bg-amber-100 text-amber-800 border-amber-200',
    accent: 'bg-amber-300',
    selected: 'border-amber-400 bg-amber-50',
  },
  팀장: {
    chip: 'bg-violet-100 text-violet-800 border-violet-200',
    accent: 'bg-violet-300',
    selected: 'border-violet-400 bg-violet-50',
  },
  사수: {
    chip: 'bg-sky-100 text-sky-800 border-sky-200',
    accent: 'bg-sky-300',
    selected: 'border-sky-400 bg-sky-50',
  },
  부사수: {
    chip: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    accent: 'bg-emerald-300',
    selected: 'border-emerald-400 bg-emerald-50',
  },
};

/** Falls back to a neutral chip if a record carries an unknown title. */
export function titleStyle(title: string): TitleStyle {
  return (
    TITLE_STYLES[title as TechnicianTitle] ?? {
      chip: 'bg-slate-100 text-slate-700 border-slate-200',
      accent: 'bg-slate-300',
      selected: 'border-slate-400 bg-slate-50',
    }
  );
}
