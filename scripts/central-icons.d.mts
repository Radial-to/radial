// The part of @central-icons-react/all that scripts/build-icons.mts and
// scripts/find-icon.mts use. The package is licensed and optional: the public
// repo doesn't have it, and where it is installed its own types allow only the
// 2,000+ names it ships. These scripts render whatever names they scan or are
// given and treat an SVG without a <path> as missing, so `name` is a string here.
// An ambient module wins over the installed package's types, so the scripts
// type-check the same with or without it. (A .d.mts so the scripts project's
// "./**/*.mts" include picks it up; no top-level import keeps it ambient.)
declare module '@central-icons-react/all' {
  import type { FC } from 'react';
  /** The package's CentralIconProps, as these scripts pass them. */
  export interface CentralIconProps {
    /** An icon name. One the package doesn't have renders without a <path>. */
    name: string;
    join: 'round' | 'square';
    fill: 'filled' | 'outlined';
    radius: '0' | '1' | '2' | '3';
    stroke: '1' | '1.5' | '2';
    color?: string;
    size?: string | number;
  }
  /** One icon as an <svg> in the given style. */
  export const CentralIcon: FC<CentralIconProps>;
}
