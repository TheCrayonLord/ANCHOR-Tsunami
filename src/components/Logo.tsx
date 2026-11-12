/** ANCHOR Tsunami mark: an anchor rising out of a breaking wave. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="logo">
      <defs>
        <linearGradient id="at-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#14b8c4" />
          <stop offset="1" stopColor="#1d4ed8" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="16" fill="url(#at-g)" />
      <g fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="32" cy="14.5" r="4" />
        <path d="M32 18.5v24" />
        <path d="M24 25h16" />
        <path d="M16 34c1.5 8 8 12.5 16 12.5S46.5 42 48 34" />
      </g>
      <path d="M4 50c6-4 10-4 15 0s10 4 14 0 9-4 14 0 9 4 13 0v12H4z" fill="#fff" opacity=".9" />
      <path d="M4 55c6-4 10-4 15 0s10 4 14 0 9-4 14 0 9 4 13 0" fill="none" stroke="#1d4ed8" strokeWidth="2" opacity=".5" />
    </svg>
  );
}
