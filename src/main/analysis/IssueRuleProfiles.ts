import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  BUILTIN_ISSUE_RULE_PROFILE_ID,
  ISSUE_RULE_PROFILE_LIMITS,
  defaultIssueRuleProfile,
  type IssueRuleActionResult,
  type IssueRuleProfile,
  type IssueRuleProfilesState,
} from "@shared/contracts/issueRules";
import { issueRuleStateFileSchema, parseIssueRuleProfileInput } from "./issueRuleSchema";

const FILE_NAME = "issue-rules.v1.json";
const MAX_BYTES = 1_048_576;
const READ_FAILED = "问题警告方案读取失败，已回到标准方案。";
const WRITE_FAILED = "问题警告方案保存失败，请检查本机数据目录权限。";
const LOCKED = "盯播进行中不能修改问题警告方案。";

type Loaded = {
  activeProfileId: string;
  profiles: IssueRuleProfile[];
  warning: string | null;
};

export class IssueRuleProfiles {
  private cache: Loaded | null = null;

  constructor(private readonly root: () => string) {}

  state(): IssueRuleProfilesState {
    const loaded = this.load();
    const builtin = defaultIssueRuleProfile();
    const activeProfile =
      loaded.profiles.find((profile) => profile.id === loaded.activeProfileId) ?? builtin;
    return {
      profiles: [
        { id: builtin.id, name: builtin.name, updatedAt: builtin.updatedAt, builtin: true },
        ...loaded.profiles.map((profile) => ({
          id: profile.id,
          name: profile.name,
          updatedAt: profile.updatedAt,
          builtin: false,
        })),
      ],
      activeProfileId: activeProfile.id,
      activeProfile: structuredClone(activeProfile),
      warning: loaded.warning,
    };
  }

  activeProfile(): IssueRuleProfile {
    return this.state().activeProfile;
  }

  save(raw: unknown): IssueRuleActionResult {
    const parsed = parseIssueRuleProfileInput(raw);
    if (!parsed) return this.failure("方案内容不合法，请检查名称、关键词与阈值。");
    const loaded = this.load();
    const existing = loaded.profiles.find((profile) => profile.id === parsed.id);
    if (!existing && loaded.profiles.length >= ISSUE_RULE_PROFILE_LIMITS.maxProfiles) {
      return this.failure(`最多保存 ${ISSUE_RULE_PROFILE_LIMITS.maxProfiles} 个方案，请先删除不用的方案。`);
    }
    const id =
      parsed.id === BUILTIN_ISSUE_RULE_PROFILE_ID || !existing ? randomUUID() : parsed.id;
    const profile: IssueRuleProfile = {
      ...parsed,
      id,
      updatedAt: new Date().toISOString(),
    };
    const profiles = existing
      ? loaded.profiles.map((item) => (item.id === id ? profile : item))
      : [...loaded.profiles, profile];
    return this.persist({ activeProfileId: id, profiles, warning: null }, "已保存，下次开始生效。");
  }

  remove(id: string): IssueRuleActionResult {
    if (id === BUILTIN_ISSUE_RULE_PROFILE_ID) return this.failure("内置方案不能删除。");
    const loaded = this.load();
    if (!loaded.profiles.some((profile) => profile.id === id)) {
      return this.failure("方案不存在或已被删除。");
    }
    const profiles = loaded.profiles.filter((profile) => profile.id !== id);
    const activeProfileId =
      loaded.activeProfileId === id ? BUILTIN_ISSUE_RULE_PROFILE_ID : loaded.activeProfileId;
    return this.persist({ activeProfileId, profiles, warning: null }, "方案已删除。");
  }

  activate(id: string): IssueRuleActionResult {
    const loaded = this.load();
    const exists =
      id === BUILTIN_ISSUE_RULE_PROFILE_ID || loaded.profiles.some((profile) => profile.id === id);
    if (!exists) return this.failure("方案不存在或已被删除。");
    return this.persist(
      { activeProfileId: id, profiles: loaded.profiles, warning: null },
      "已切换当前方案，下次开始生效。",
    );
  }

  private failure(message: string): IssueRuleActionResult {
    return { ok: false, message, state: this.state() };
  }

  private persist(next: Loaded, message: string): IssueRuleActionResult {
    try {
      const root = this.root();
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const file = path.join(root, FILE_NAME);
      writeFileSync(
        `${file}.tmp`,
        JSON.stringify(
          {
            schemaVersion: 1,
            activeProfileId: next.activeProfileId,
            profiles: next.profiles,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      renameSync(`${file}.tmp`, file);
      this.cache = next;
      return { ok: true, message, state: this.state() };
    } catch {
      return this.failure(WRITE_FAILED);
    }
  }

  private load(): Loaded {
    if (this.cache) return this.cache;
    this.cache = this.read();
    return this.cache;
  }

  private read(): Loaded {
    const fallback: Loaded = {
      activeProfileId: BUILTIN_ISSUE_RULE_PROFILE_ID,
      profiles: [],
      warning: null,
    };
    try {
      const file = path.join(this.root(), FILE_NAME);
      if (!existsSync(file)) return fallback;
      if (statSync(file).size > MAX_BYTES) throw new Error("too large");
      const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
      const parsed = issueRuleStateFileSchema.parse(raw);
      const profiles = parsed.profiles.filter(
        (profile) => profile.id !== BUILTIN_ISSUE_RULE_PROFILE_ID,
      ) as IssueRuleProfile[];
      const activeProfileId = profiles.some((profile) => profile.id === parsed.activeProfileId)
        ? parsed.activeProfileId
        : BUILTIN_ISSUE_RULE_PROFILE_ID;
      return { activeProfileId, profiles, warning: null };
    } catch {
      return { ...fallback, warning: READ_FAILED };
    }
  }
}

export const ISSUE_RULE_LOCKED_MESSAGE = LOCKED;
