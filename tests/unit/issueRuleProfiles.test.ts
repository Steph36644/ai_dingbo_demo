import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IssueRuleProfiles } from "../../src/main/analysis/IssueRuleProfiles";
import {
  BUILTIN_ISSUE_RULE_PROFILE_ID,
  defaultIssueRuleProfile,
} from "../../src/shared/contracts/issueRules";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "issue-rules-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0, roots.length)) rmSync(root, { recursive: true, force: true });
});

describe("问题警告方案存储", () => {
  it("默认只有内置方案，且内置方案只读", () => {
    const store = new IssueRuleProfiles(() => tempRoot());
    const state = store.state();
    expect(state.profiles).toHaveLength(1);
    expect(state.activeProfileId).toBe(BUILTIN_ISSUE_RULE_PROFILE_ID);
    expect(state.activeProfile.name).toBe("标准盯播方案");
    expect(state.activeProfile.repeatReminderIntervalMs).toBe(0);
    expect(store.remove(BUILTIN_ISSUE_RULE_PROFILE_ID).ok).toBe(false);
  });

  it("保存、切换和删除方案，删除当前方案后回到内置", () => {
    const root = tempRoot();
    const store = new IssueRuleProfiles(() => root);
    const draft = defaultIssueRuleProfile("我的方案", "local-draft", new Date().toISOString());
    draft.repeatReminderIntervalMs = 60_000;
    draft.customRules = [
      {
        id: "r1",
        name: "禁止承诺发货时效",
        keywords: ["当天发货"],
        severity: "warning",
        suggestion: "",
        enabled: true,
      },
    ];
    const saved = store.save(draft);
    expect(saved.ok).toBe(true);
    expect(saved.state.profiles).toHaveLength(2);
    const savedId = saved.state.activeProfileId;
    expect(savedId).not.toBe(BUILTIN_ISSUE_RULE_PROFILE_ID);
    expect(saved.state.activeProfile.repeatReminderIntervalMs).toBe(60_000);

    const reloaded = new IssueRuleProfiles(() => root);
    expect(reloaded.state().activeProfileId).toBe(savedId);
    expect(reloaded.state().activeProfile.customRules[0]?.keywords).toEqual(["当天发货"]);

    expect(reloaded.activate(BUILTIN_ISSUE_RULE_PROFILE_ID).state.activeProfileId).toBe(
      BUILTIN_ISSUE_RULE_PROFILE_ID,
    );
    expect(reloaded.activate(savedId).state.activeProfileId).toBe(savedId);

    const removed = reloaded.remove(savedId);
    expect(removed.ok).toBe(true);
    expect(removed.state.profiles).toHaveLength(1);
    expect(removed.state.activeProfileId).toBe(BUILTIN_ISSUE_RULE_PROFILE_ID);
  });

  it("拒绝不合法的方案内容", () => {
    const store = new IssueRuleProfiles(() => tempRoot());
    const draft = defaultIssueRuleProfile("方案", "draft", new Date().toISOString());
    expect(store.save({ ...draft, name: "" }).ok).toBe(false);
    expect(store.save({ ...draft, pace: { ...draft.pace, min: 400, max: 200 } }).ok).toBe(false);
    expect(store.state().profiles).toHaveLength(1);
  });

  it("文件损坏时回退内置方案并给出提示", () => {
    const root = tempRoot();
    writeFileSync(path.join(root, "issue-rules.v1.json"), "{ broken", "utf8");
    const state = new IssueRuleProfiles(() => root).state();
    expect(state.activeProfileId).toBe(BUILTIN_ISSUE_RULE_PROFILE_ID);
    expect(state.warning).toContain("读取失败");
    expect(state.profiles).toHaveLength(1);
  });
});
