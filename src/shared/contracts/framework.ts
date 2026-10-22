export type FrameworkItem = {
  id: string;
  text: string;
  keywords: string[];
};

export type FrameworkStage = {
  id: string;
  name: string;
  hint?: string;
};

export type FrameworkDocument = {
  id?: string;
  title?: string;
  pace: {
    min: number;
    max: number;
    unit: "chars_per_minute";
    note?: string;
  };
  must_say: FrameworkItem[];
  avoid: FrameworkItem[];
  stages?: FrameworkStage[];
};

export type FrameworkLoadResult =
  | {
      ok: true;
      revision: string;
      sourcePath: string | null;
      document: FrameworkDocument;
    }
  | {
      ok: false;
      code: "invalid_framework" | "io_error" | "session_active";
      message: string;
      jsonPath?: string;
      sourcePath?: string;
    };
