/** A rectangle in PDF user space (bottom-left origin, unrotated page coordinates). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ItemKind =
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'note'
  | 'text'
  | 'image'
  | 'stamp'
  | 'redact'
  | 'whiteout'
  | 'link'
  | 'field'
  | 'measure'
  | 'highlight'
  | 'underline'
  | 'strikeout'
  | 'squiggly';

export type FieldType = 'text' | 'multiline' | 'checkbox' | 'radio' | 'dropdown' | 'listbox' | 'button';

/** A pending edit drawn by ANCHOR Tsunami's own tools; written into the PDF on commit. */
export interface OverlayItem {
  id: string;
  page: number; // 0-based
  kind: ItemKind;
  rect: Rect;
  /** For line / arrow / measure: start and end points in user space. */
  pts?: [number, number][];
  color?: string; // stroke or text colour, hex
  fill?: string | null; // fill colour, hex
  width?: number; // stroke width in pt
  opacity?: number; // 0..1
  text?: string; // note / text / stamp label
  fontSize?: number;
  font?: 'Helvetica' | 'Times' | 'Courier';
  bold?: boolean;
  italic?: boolean;
  align?: 'left' | 'center' | 'right';
  /** For "edit text": area of the original text that is covered before the new text is drawn. */
  cover?: Rect;
  dataUrl?: string; // image / signature
  url?: string; // link target
  destPage?: number; // link target page (0-based)
  fieldType?: FieldType;
  name?: string; // form field name
  options?: string[]; // dropdown / list / radio options
  author?: string;
  /** Text markup: one rectangle per covered text run. */
  quads?: Rect[];
  /** Keep each line on one line (used when editing existing text). */
  nowrap?: boolean;
  lineHeight?: number; // multiple of the font size
}

export interface DocMeta {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
}

export interface TextRun {
  str: string;
  rect: Rect; // user space
  fontSize: number;
  fontName?: string;
  family?: string; // CSS font family for measuring
  color?: string; // hex fill colour, when known
}
