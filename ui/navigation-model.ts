export interface NavigationControl {
  readonly key: string;
  readonly label: string;
  readonly size: number;
  readonly value: number;
  readonly labels?: readonly string[];
  readonly go: (value: number) => void;
}
export interface NavigationModel {
  title: string;
  controls: readonly NavigationControl[];
  hints: readonly string[];
  note: string;
  loading: boolean;
  resolution?: { preview: string; detail: string; description: string };
  ready: (node: HTMLDivElement) => void;
  toggle: () => void;
  held: () => boolean;
  hold: () => void;
}
