/**
 * 个人中心的「资料编辑卡」—— 点「编辑资料」展开的那一张。
 *
 * ══ 为什么抽成一个文件 ══════════════════════════════════════════════════
 *  `PersonalCenterView.ts` 已经两千多行，而这块自己带着一套状态（草稿 /
 *  脏 / 保存中），塞回去会让它更难读。这里只做一件事：**把三行的编辑状态
 *  收敛成一个草稿，右下角一颗「保存」统一提交**。
 *
 * ══ 2026-10-15 改了什么 ══════════════════════════════════════════════
 *  以前三行各自带着「修改 / 保存 / 取消」，改完任何一项都会 `renderProfile()`
 *  整页重绘 —— 于是卡片随之消失，看着像"改完就崩了"。现在的规矩是：
 *
 *  · **只有三个东西能关掉这张卡**：右上箭头（＝「编辑资料」那个钮变形）、
 *    「取消」、「保存」；改头像、改昵称、改邮箱都只在这一张卡里就地生效。
 *  · 头像与昵称先进**草稿**，点保存才提交；邮箱是例外 —— 它要过新邮箱的验证码，
 *    服务端是"确认即改绑"，没有草稿态，所以它保持即时生效（并在行里写明）。
 *  · 昵称不再即时生效：提交后进入 ops 审核队列，`nickname` 一个字都不动，
 *    行里会显示"正在审核"。
 *
 * ⚠️ 这个类**不自己负责重绘整页** —— 那是 `renderProfile()` 的事。这里任何一处
 *    调 `renderProfile()` 都会把这张卡连带关掉，正是要修的那个毛病。
 */
import { Notice } from "obsidian";

import type YoungLookPlugin from "../main";
import { createButton } from "../ui/button";
import {
  confirmEmailChange,
  requestEmailChange,
  updateAvatar,
  updateNickname,
} from "../services/auth/authApi";
import { AvatarCropModal } from "./AvatarCropModal";

/** 昵称行此刻的形态：能不能改、不能改的话因为什么。 */
type NickState =
  /** 正常可改 */
  | { kind: "editable"; hint?: string }
  /** 有申请在 ops 排队 */
  | { kind: "pending"; hint: string }
  /** 上次申请被驳回 —— 可以改，但要告诉用户上次的没通过 */
  | { kind: "rejected"; hint: string }
  /** 30 天冷却没过 */
  | { kind: "cooling"; hint: string };

export interface ProfileEditCardContext {
  plugin: YoungLookPlugin;
  /** 身份头那颗 52px 圆 —— 选完头像要立刻反映到它身上，不用等保存 */
  heroAvatar: HTMLElement;
  /**
   * 收起这张卡。
   * @param rerender true = 保存成功，整页重绘（导读新头像 / 新的审核状态）；
   *                 false = 放弃草稿，就地收起（滚动位置与别的页签不动）
   */
  close: (rerender: boolean) => void;
}

interface Draft {
  /** 裁好但还没上传的图 */
  avatarFile: File | null;
  /** avatarFile 的本地预览 URL；所有权在**这里**（class 自己 revoke） */
  avatarPreviewUrl: string | null;
  /** 昵称草稿：null = 没动过 */
  nickname: string | null;
  /** 这一轮的昵称申请已经提交了 —— 防止重试点保存再次撞「还在审核中」 */
  nickSubmitted: boolean;
}

export class ProfileEditCard {
  private readonly draft: Draft = {
    avatarFile: null,
    avatarPreviewUrl: null,
    nickname: null,
    nickSubmitted: false,
  };
  private nickInput: HTMLInputElement | null = null;
  private nickHint: HTMLElement | null = null;
  private saveBtn: HTMLButtonElement | null = null;
  private cancelBtn: HTMLButtonElement | null = null;
  private avatarRowBody: HTMLElement | null = null;
  private busy = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly ctx: ProfileEditCardContext,
  ) {}

  /** 建出三行 + 右下角的取消 / 保存。每次打开调一次（外层每次都是新实例）。 */
  render(): void {
    this.renderAvatarRow();
    this.renderNickRow();
    this.renderEmailRow();
    this.renderFoot();
  }

  /**
   * 丢弃草稿并释放预览 URL。
   *
   * ⚠️ 预览 URL 是 `URL.createObjectURL` 造出来的，**不 revoke 就一直占着内存**
   *    —— 每次重选一张图漏一个，攒起来没人看得见，只体现为插件越来越吃内存。
   */
  dispose(): void {
    if (this.draft.avatarPreviewUrl) URL.revokeObjectURL(this.draft.avatarPreviewUrl);
    this.draft.avatarPreviewUrl = null;
    this.draft.avatarFile = null;
  }

  // ── ① 头像 ────────────────────────────────────────────────────────────

  private renderAvatarRow(): void {
    const row = this.host.createDiv({ cls: "yl-pc-wrow" });
    row.createDiv({ cls: "yl-pc-wlabel", text: "头像" });
    const body = row.createDiv({ cls: "yl-pc-wvalue" });
    this.avatarRowBody = body;
    this.paintAvatarPreview();

    const pick = createButton(row, { text: "更换头像" });
    const file = row.createEl("input", {
      attr: { type: "file", accept: "image/*" },
    });
    file.hide();
    pick.addEventListener("click", () => file.click());
    file.addEventListener("change", () => {
      const chosen = file.files?.[0];
      // 清掉 value：选同一个文件第二次也要能弹出裁剪器
      file.value = "";
      if (!chosen) return;
      this.openCropper(chosen);
    });
  }

  private openCropper(chosen: File): void {
    new AvatarCropModal(this.ctx.plugin.app, chosen, {
      onDone: ({ file, previewUrl }) => {
        // 换掉了上一张草稿 → 上一张的预览 URL 没人用了
        this.dispose();
        this.draft.avatarFile = file;
        this.draft.avatarPreviewUrl = previewUrl;
        this.paintAvatarPreview();
        this.paintHeroAvatar(previewUrl);
        this.syncSaveState();
      },
    }).open();
  }

  private paintAvatarPreview(): void {
    const body = this.avatarRowBody;
    if (!body) return;
    body.empty();
    const preview = body.createDiv({ cls: "yl-v3-avatar yl-v3-avatar-sm" });
    const nickname = this.ctx.plugin.settings.accountProfile?.nickname ?? "洋";
    preview.createSpan({ text: nickname.slice(0, 1) });
    const url = this.draft.avatarPreviewUrl ?? this.ctx.plugin.accountAvatarUrl();
    if (url) this.mountImage(preview, url);

    if (this.draft.avatarPreviewUrl) {
      body.createDiv({
        cls: "yl-pc-hint",
        text: "还没保存 —— 点下面的「保存」才真的换上去。",
      });
      createButton(body, {
        shape: "text",
        text: "撤销",
        onClick: () => {
          this.dispose();
          this.paintAvatarPreview();
          this.paintHeroAvatar(this.ctx.plugin.accountAvatarUrl());
          this.syncSaveState();
        },
      });
    } else {
      body.createDiv({
        cls: "yl-pc-hint",
        text: "JPG / PNG / WEBP · 5MB 内 · 选好后可以调位置，圆形是界面上看到的部分",
      });
    }
  }

  private paintHeroAvatar(url: string | null): void {
    // 身份头：图是绝对定位铺在最上层（见 styles.css 的 .yl-v3-avatar img），
    // 换图只需要换那颗 img，字母兜底不用动。
    const hero = this.ctx.heroAvatar;
    hero.querySelectorAll("img").forEach((img) => img.remove());
    if (url) this.mountImage(hero, url);
  }

  private mountImage(target: HTMLElement, url: string): void {
    const img = target.createEl("img", { attr: { src: url, alt: "" } });
    img.addEventListener("error", () => img.remove());
  }

  // ── ② 昵称 ────────────────────────────────────────────────────────────

  private renderNickRow(): void {
    const row = this.host.createDiv({ cls: "yl-pc-wrow" });
    row.createDiv({ cls: "yl-pc-wlabel", text: "昵称" });
    const body = row.createDiv({ cls: "yl-pc-wvalue" });
    const state = this.nickState();
    const profile = this.ctx.plugin.settings.accountProfile;

    const input = body.createEl("input", {
      cls: "yl-pc-input",
      attr: {
        type: "text",
        maxlength: "20",
        value: state.kind === "pending" ? this.pendingNickname() : profile?.nickname ?? "",
      },
    });
    this.nickInput = input;
    if (state.kind === "pending" || state.kind === "cooling") input.disabled = true;
    if (this.draft.nickSubmitted) input.disabled = true;

    this.nickHint = body.createDiv({ cls: "yl-pc-hint", text: state.hint ?? this.defaultNickHint() });
    if (state.kind === "pending" || state.kind === "cooling") this.nickHint.addClass("is-warn");

    input.addEventListener("input", () => {
      const value = input.value.trim();
      this.draft.nickname = value && value !== profile?.nickname ? value : null;
      this.syncSaveState();
    });
  }

  private pendingNickname(): string {
    const profile = this.ctx.plugin.settings.accountProfile;
    return profile?.nicknamePending?.trim() || profile?.nickname || "";
  }

  private defaultNickHint(): string {
    return "平台内不能重名 · 改完要等审核 · 通过后 30 天内不能再改";
  }

  /**
   * 昵称这四个形态：能改 / 在审 / 上次被驳回 / 冷却没过。
   *
   * ⚠️ 冷却的判断用**服务端算好的** `nicknameNextChangeAt`，不在本地加 30 天 ——
   *    规则只在服务端，本机时钟也不一定准；本机算出来的结论跟服务端不一致时，
   *    用户看到的是"显示可以改、点了却被拒"。
   */
  private nickState(): NickState {
    const profile = this.ctx.plugin.settings.accountProfile;
    const pending = profile?.nicknamePending?.trim() ?? "";

    if (profile?.nicknameStatus === "pending" && pending) {
      return { kind: "pending", hint: `「${pending}」正在审核中，通过后生效` };
    }
    if (profile?.nicknameStatus === "rejected" && pending) {
      return { kind: "rejected", hint: `上次申请的「${pending}」没通过，换一个再提交` };
    }
    const gate = profile?.nicknameNextChangeAt;
    if (gate) {
      const at = new Date(gate);
      if (Number.isFinite(at.getTime()) && at.getTime() > Date.now()) {
        return {
          kind: "cooling",
          hint: `昵称刚改过，${at.getMonth() + 1}月${at.getDate()}日之后才能再改`,
        };
      }
    }
    return { kind: "editable" };
  }

  // ── ③ 邮箱 ────────────────────────────────────────────────────────────

  /**
   * 邮箱行。**保持即时生效**（用户拍板）：换邮箱要过新邮箱的验证码，服务端是
   * 「确认即改绑」，没有草稿态把它塞进统一的保存里既别扭又有验证码过期的风险。
   * 它唯一要守的规矩是：**改完不整页重绘**（那样会关掉整张卡）。
   */
  private renderEmailRow(value?: string): void {
    const row = this.host.createDiv({ cls: "yl-pc-wrow is-editing" });
    row.createDiv({ cls: "yl-pc-wlabel", text: "邮箱" });
    const profile = this.ctx.plugin.settings.accountProfile;
    const current = value ?? profile?.email ?? "";

    const input = row.createEl("input", {
      cls: "yl-pc-input",
      attr: { type: "email", placeholder: "新邮箱", value: current },
    });
    const send = createButton(row, { text: "发送验证码" });
    const code = row.createEl("input", {
      cls: "yl-pc-input",
      attr: { type: "text", placeholder: "6 位验证码", maxlength: "6" },
    });
    code.hide();
    const hint = row.createDiv({
      cls: "yl-pc-hint",
      text: "邮箱是登录凭证，改完立即生效（不跟着「保存」一起走）",
    });

    send.addEventListener("click", async () => {
      const next = input.value.trim();
      if (!next) return;
      send.disabled = true;
      send.setText("发送中…");
      try {
        await requestEmailChange(this.ctx.plugin.settings, next);
        new Notice("验证码已发送到新邮箱（10 分钟内有效）");
        input.disabled = true;
        send.setText("已发送");
        code.show();
        hint.setText("验证码 10 分钟内有效，填完点「确认修改」就改绑");
        const confirm = createButton(row, { role: "primary", text: "确认修改" });
        confirm.addEventListener("click", async () => {
          confirm.disabled = true;
          try {
            const email = await confirmEmailChange(this.ctx.plugin.settings, next, code.value);
            if (this.ctx.plugin.settings.accountProfile) {
              this.ctx.plugin.settings.accountProfile.email = email;
              await this.ctx.plugin.saveSettings();
            }
            new Notice("邮箱已更新");
            // 🔴 只重画这一行 —— 整页重绘会把整张卡连带关掉（那正是要修的毛病）。
            //   顺序不能错：先把底栏摘下来，再补新行、最后把底栏排回去，
            //   否则新行会排在「取消 / 保存」后面。
            row.remove();
            this.host.querySelector(".yl-pc-editfoot")?.remove();
            this.renderEmailRow(email);
            this.renderFoot();
          } catch (error) {
            new Notice(error instanceof Error ? error.message : "邮箱没改成");
            confirm.disabled = false;
          }
        });
        window.setTimeout(() => code.focus(), 0);
      } catch (error) {
        new Notice(error instanceof Error ? error.message : "验证码没发出去");
        send.disabled = false;
        send.setText("发送验证码");
      }
    });
  }

  // ── 右下角：取消 / 保存 ───────────────────────────────────────────────

  private renderFoot(): void {
    const foot = this.host.createDiv({ cls: "yl-pc-editfoot" });
    this.cancelBtn = createButton(foot, {
      text: "取消",
      onClick: () => {
        this.dispose();
        this.ctx.close(false);
      },
    });
    this.saveBtn = createButton(foot, {
      role: "primary",
      text: "保存",
      disabled: true,
      onClick: () => void this.save(),
    });
    this.syncSaveState();
  }

  private syncSaveState(): void {
    if (!this.saveBtn) return;
    this.saveBtn.disabled = this.busy || !this.isDirty();
  }

  /**
   * 有没有东西要提。
   *
   * 昵称草稿在「已提交」「审核中」「冷却中」三种情况下都**不算脏** ——
   * 那些时候输入框本来就禁用着，把它算成脏会让保存钮明明点了却无事发生。
   */
  private isDirty(): boolean {
    return Boolean(this.draft.avatarFile) || Boolean(this.draft.nickname);
  }

  private async save(): Promise<void> {
    if (this.busy || !this.isDirty()) return;
    const wantNick = this.draft.nickname;
    const wantAvatar = this.draft.avatarFile;
    this.busy = true;
    this.syncSaveState();
    if (this.saveBtn) this.saveBtn.setText("保存中…");
    if (this.cancelBtn) this.cancelBtn.disabled = true;

    // 🔴 顺序：**昵称先、头像后**。
    //    反过来一旦头像已经落盘（服务端立刻存成文件、那是用户资产）而昵称提交
    //    失败，头像是没法回滚的；现在这个顺序下，最坏情况是"昵称已进审核、
    //    头像还没传"，用户可以重来。
    let nicknameDone = false;
    try {
      if (wantNick) {
        await updateNickname(this.ctx.plugin.settings, wantNick);
        nicknameDone = true;
        // 立刻从草稿里摘掉：再点保存（比如头像那步失败了要重试）不能又把同一份
        // 申请提交一次 —— 服务端会因为「还在审核中」把他打回来。
        this.draft.nickname = null;
        this.draft.nickSubmitted = true;
        if (this.nickInput) {
          this.nickInput.disabled = true;
          this.nickInput.value = wantNick;
        }
        if (this.nickHint) {
          this.nickHint.setText(`「${wantNick}」已提交，审核通过后生效`);
          this.nickHint.addClass("is-warn");
        }
      }
      if (wantAvatar) {
        const path = await updateAvatar(this.ctx.plugin.settings, wantAvatar);
        // 上传成功 → 预览 URL 完成使命，正式地址由服务端给
        if (this.ctx.plugin.settings.accountProfile) {
          this.ctx.plugin.settings.accountProfile.avatarUrl = path;
          await this.ctx.plugin.saveSettings();
        }
      }
      // 强拉一次快照：60 秒节流会让「审核中」三个字迟到一分钟，
      // 而用户刚点完保存，这时候不刷新等于说"没生效"。
      await this.ctx.plugin.refreshAccountProfile(true);
      new Notice(nicknameDone ? "已保存。昵称审核通过后生效" : "已保存");
      this.dispose();
      this.ctx.close(true);
      return;
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "没保存成功");
      this.busy = false;
      if (this.saveBtn) this.saveBtn.setText("保存");
      if (this.cancelBtn) this.cancelBtn.disabled = false;
      // 🔴 卡片**保持展开**：已经提交出去的那份草稿留下了，重来一次只补剩下的
      this.syncSaveState();
    }
  }
}
