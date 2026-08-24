/**
 * A stable colour per 시공종류.
 *
 * The list is admin-editable, so colours cannot be hard-coded per brand. They
 * are derived from the name instead: the same 시공종류 always lands on the same
 * hue, on every screen and every machine, with nothing extra to store or keep
 * in sync. Adding a type never reshuffles the existing ones.
 *
 * Hues are kept in the same pastel weight as the 직함 chips so that neither
 * reads as an alert — both are categories, not statuses.
 */

export interface TypeStyle {
  /** Small chip in lists. */
  chip: string;
  /** Larger selectable button on the submission form. */
  selected: string;
  /** Dot / bar accent. */
  accent: string;
}

const PALETTE: TypeStyle[] = [
  {
    chip: 'bg-blue-100 text-blue-800 border-blue-200',
    selected: 'border-blue-500 bg-blue-50 text-blue-900',
    accent: 'bg-blue-400',
  },
  {
    chip: 'bg-rose-100 text-rose-800 border-rose-200',
    selected: 'border-rose-500 bg-rose-50 text-rose-900',
    accent: 'bg-rose-400',
  },
  {
    chip: 'bg-amber-100 text-amber-900 border-amber-200',
    selected: 'border-amber-500 bg-amber-50 text-amber-900',
    accent: 'bg-amber-400',
  },
  {
    chip: 'bg-teal-100 text-teal-800 border-teal-200',
    selected: 'border-teal-500 bg-teal-50 text-teal-900',
    accent: 'bg-teal-400',
  },
  {
    chip: 'bg-fuchsia-100 text-fuchsia-800 border-fuchsia-200',
    selected: 'border-fuchsia-500 bg-fuchsia-50 text-fuchsia-900',
    accent: 'bg-fuchsia-400',
  },
  {
    chip: 'bg-lime-100 text-lime-900 border-lime-200',
    selected: 'border-lime-500 bg-lime-50 text-lime-900',
    accent: 'bg-lime-400',
  },
  {
    chip: 'bg-indigo-100 text-indigo-800 border-indigo-200',
    selected: 'border-indigo-500 bg-indigo-50 text-indigo-900',
    accent: 'bg-indigo-400',
  },
  {
    chip: 'bg-orange-100 text-orange-900 border-orange-200',
    selected: 'border-orange-500 bg-orange-50 text-orange-900',
    accent: 'bg-orange-400',
  },
  {
    chip: 'bg-cyan-100 text-cyan-800 border-cyan-200',
    selected: 'border-cyan-500 bg-cyan-50 text-cyan-900',
    accent: 'bg-cyan-400',
  },
  {
    chip: 'bg-pink-100 text-pink-800 border-pink-200',
    selected: 'border-pink-500 bg-pink-50 text-pink-900',
    accent: 'bg-pink-400',
  },
];

/** FNV-1a — small, and spreads similar names (백조 / 백조2) far apart. */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function typeStyle(name: string): TypeStyle {
  return PALETTE[hash(name || '') % PALETTE.length];
}
