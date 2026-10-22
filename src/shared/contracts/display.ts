export type DisplayInfo = {
  id: number;
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  rotation: number;
  internal: boolean;
};

export type StageOpenMode = "window" | "fullscreen";

export type StageOpenRequest = {
  displayId: number;
  mode: StageOpenMode;
};

export type StagePreferences = {
  displayId: number | null;
  mode: StageOpenMode;
};
