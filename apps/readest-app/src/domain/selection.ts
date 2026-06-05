export interface Frame {
  top: number;
  left: number;
}

export interface Rect {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Point {
  x: number;
  y: number;
}

export type PositionDir = 'up' | 'down' | 'left' | 'right';

export interface Position {
  point: Point;
  dir?: PositionDir;
}

export interface TextSelection {
  key: string;
  text: string;
  page: number;
  range: Range;
  index: number;
  cfi?: string;
  href?: string;
  annotated?: boolean;
  rect?: Rect;
}
