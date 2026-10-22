# SDD 版本管理

SDD（Software Design Document，软件设计文档）与 PRD 使用一致的 **latest + CHANGELOG + git tag** 保管方式，仍用 SemVer。冻结某版时，必须把当时的 `latest.md` 完整复制为 `versions/vX.Y.Z.md`。

## 规则

1. **唯一工作稿**：`docs/sdd/latest.md`。聊天里说的「改 SDD / 改技术方案」默认改它。已冻结的 `versions/` 快照不再改。
2. **冻结**：技术方案评审通过并拍板后，在包含该版 `latest.md` 的 commit 上打 tag `sdd-vX.Y.Z`，并把当时的 `latest.md` 完整复制为 `docs/sdd/versions/vX.Y.Z.md`。
3. **语义化版本（SemVer）**
   - **major**（1.0.0）：整体架构或核心数据流推翻，例如桌面单体改为云端服务、取消环回采音。
   - **minor**（0.2.0）：新增子系统、外部依赖、持久化能力或重要接口，调整非功能性验收标准。
   - **patch**（0.1.1）：澄清设计、补充示例、修正文档错误，不改变已定架构与接口行为。
4. **PRD 对齐**：SDD 文头记录其依据的 PRD 版本。PRD 变化后先评估影响，再同步工作稿；不能只改版本号。
5. **CHANGELOG**：每次冻结 SDD 版本，都在 `docs/CHANGELOG.md` 的对应版本区块记录显著变更。
6. **快照**：`versions/` 保留各版完整快照，供直接对照。`v0.1.0.md` 仍保留。

## 当前

- 工作稿：`latest.md` → **v1.0.0 Draft**（与 PRD 同号，未冻结。已交付行为以 main 代码为准；M6 出站与 M7 未实现；PR #23 未合）
- 2026-10-20 对齐 PRD 门禁补强：§1.1 写明动作提醒的模块边界。角色校验保持 PR #22 已合，不恢复过时描述
- 最近已打 tag：`sdd-v0.2.0`
- 对齐需求：`docs/prd/latest.md` → **PRD v1.0.0 Draft**
- 快照：`versions/v0.3.0.md`（#11 合入时的 `latest.md` 全文）、`versions/v0.2.0.md`（与 tag `sdd-v0.2.0` 当时的 `latest.md` 一致）、`versions/v0.1.0.md`。尚无 `versions/v1.0.0.md`
- tag `sdd-v0.3.0`、`sdd-v1.0.0` 均未打。本轮不打 tag，不复制 `versions/`
- FunASR 协议桥已并入 `latest.md` 基线（见 SDD §4 / §7.2 与 §21）：`funasr-protocol-bridge.md`
- SenseVoice 旁路探针：ADR-018（`docs/adr/ADR-018-sensevoice-bypass.md`）。未实现，没有与 FunASR 对等的成品协议
