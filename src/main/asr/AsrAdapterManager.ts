import type { AsrAdapter, AsrId } from "@shared/contracts/asr";
import { FakeAsrAdapter } from "./FakeAsrAdapter";
import { FunAsrAdapter, type FunAsrAdapterOptions } from "./FunAsrAdapter";
import { XfyunAsrAdapter, type XfyunAsrAdapterOptions } from "./XfyunAsrAdapter";

export class AsrAdapterManager {
  private xfyunOptions: XfyunAsrAdapterOptions | null = null;

  constructor(private readonly funasrOptions: FunAsrAdapterOptions = {}) {}

  configureXfyun(options: XfyunAsrAdapterOptions): void {
    this.xfyunOptions = options;
  }

  create(id: AsrId): AsrAdapter {
    if (id === "fake") return new FakeAsrAdapter({ loop: true });
    if (id === "funasr") return new FunAsrAdapter(this.funasrOptions);
    if (id === "xfyun") {
      if (!this.xfyunOptions) throw new Error("讯飞 RTASR 凭据服务尚未配置。");
      return new XfyunAsrAdapter(this.xfyunOptions);
    }
    throw new Error(`未知 ASR 适配器：${String(id)}`);
  }
}
