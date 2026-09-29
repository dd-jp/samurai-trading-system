export interface LseLine {
  readonly tidm: string;
  readonly isComplex: boolean;
}

// The 22 lines doc 70 §10.4 committed at Saxo (24 proposed minus IHCU and CMFP,
// both short of ten years of Saxo history). isComplex mirrors doc 70 §4l/§6.1's
// Saxo IsComplex flag; within this 22-line pool only the ETCs (SGLN, SSLN) are
// complex
export const LSE_LINES: readonly LseLine[] = [
  { tidm: 'ISF', isComplex: false },
  { tidm: 'VMID', isComplex: false },
  { tidm: 'CUKS', isComplex: false },
  { tidm: 'IUSA', isComplex: false },
  { tidm: 'CUS1', isComplex: false },
  { tidm: 'IEUX', isComplex: false },
  { tidm: 'IJPN', isComplex: false },
  { tidm: 'CPJ1', isComplex: false },
  { tidm: 'IEEM', isComplex: false },
  { tidm: 'IITU', isComplex: false },
  { tidm: 'IESU', isComplex: false },
  { tidm: 'UIFS', isComplex: false },
  { tidm: 'ICDU', isComplex: false },
  { tidm: 'SPGP', isComplex: false },
  { tidm: 'SPOG', isComplex: false },
  { tidm: 'IUKP', isComplex: false },
  { tidm: 'IGLT', isComplex: false },
  { tidm: 'INXG', isComplex: false },
  { tidm: 'SLXX', isComplex: false },
  { tidm: 'VUTY', isComplex: false },
  { tidm: 'SGLN', isComplex: true },
  { tidm: 'SSLN', isComplex: true },
];

const LSE_TIDMS: ReadonlySet<string> = new Set(LSE_LINES.map((line) => line.tidm));

export function isLseInstrument(symbol: string): boolean {
  return LSE_TIDMS.has(symbol);
}
