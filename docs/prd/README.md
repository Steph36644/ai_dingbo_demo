# PRD 版本管理

参考：[Keep a Changelog](https://keepachangelog.com/)。版本保管是 **latest + CHANGELOG + git tag**，仍用 SemVer。冻结某版时，必须把当时的 `latest.md` 完整复制为 `versions/vX.Y.Z.md`。

## 规则

1. **唯一工作稿**：`latest.md`。聊天里说的「改 PRD」默认改它。已冻结的 `versions/` 快照不再改。
2. **冻结**：对齐拍板后，在包含该版 `latest.md` 的 commit 上打 tag `prd-vX.Y.Z`，并把当时的 `latest.md` 完整复制为 `docs/prd/versions/vX.Y.Z.md`。
3. **语义化版本（SemVer）**
   - **major**（1.0.0）：产品目标或架构级推翻（例如不做环回改拉流、放弃话术框架）
   - **minor**（0.2.0）：新增 Must/Should 能力、验收标准大块变化
   - **patch**（0.1.1）：澄清措辞、补例子、修笔误、不改范围
4. **CHANGELOG**：每次冻结版本在 `docs/CHANGELOG.md` 顶部追加（Added / Changed / Removed）
5. **快照**：`versions/` 保留各版完整快照，供直接对照。`v0.1.0.md` 仍保留。

## 当前

- 工作稿：`latest.md` → **v1.0.0 Draft**（本分支 `docs/prd-v1.0.0` 的唯一编辑入口；未合 main，未冻结）
- 视觉方案设计依据：[`docs/design/visual-system.md`](../design/visual-system.md) + 参考图 [`visual-system.html`](../design/visual-system.html)。PRD §4 为规格权威，设计文档管「为什么 + 怎么落地」；改任一方需同步检查另一方
- 2026-10-20 按写作技能做了门禁补强（§8.4 通过条件、§10 分级与风险快扫）。仍是 Draft，没有 tag，没有 `versions/v1.0.0.md`
- 2026-10-21：§13 记录 SenseVoice 旁路探针（v1.x，未交付）。决策在 `docs/adr/ADR-018-sensevoice-bypass.md`。本轮不打 tag，不复制 `versions/`
- 最近已打 tag：`prd-v0.2.0`
- 快照：`versions/v0.3.0.md`（#11 合入时的 `latest.md` 全文）、`versions/v0.2.0.md`（与 tag `prd-v0.2.0` 当时的 `latest.md` 一致）、`versions/v0.1.0.md`。尚无 `versions/v1.0.0.md`
- tag `prd-v0.3.0`、`prd-v1.0.0` 均未打。本轮不打 tag，不复制 `versions/`
