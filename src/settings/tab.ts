import { PluginSettingTab, Setting, type App } from "obsidian";
import type YoungLookPlugin from "../main";
import { VIEW_TYPE_STUDY } from "../views/StudyView";
import { IS_DEV_BUILD, BUILD_ENV, BUILD_BRANCH, PRESETS, type ServerEnv } from "../config/env";
import { DEFAULT_VAULT_FOLDER } from "./defaults";
import type { PluginSettings } from "./types";
import { defaultMediaDir } from "../services/mediaStore";
import { yuanMilli } from "../ui/money";

export class SettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: YoungLookPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const settings = this.plugin.settings;

    if (IS_DEV_BUILD) {
      const banner = containerEl.createDiv({ cls: "yl-env-banner" });
      banner.createEl("strong", { text: `开发构建（分支 ${BUILD_BRANCH || "?"}）` });
      banner.appendText(
        `：连的是本机 ${settings.serverUrl}（网页端 ${this.plugin.webBase()}）。账号、余额、学习记录都走本机数据库，和线上互不相通。`,
      );
    }

    if (IS_DEV_BUILD) this.buildServerEnvSetting(containerEl);

    new Setting(containerEl)
      .setName("资料目录")
      .setDesc("Vault 里放学习资料的文件夹：笔记在 notes/、截图在 assets/、数据在 data/")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_VAULT_FOLDER)
          .setValue(settings.vaultFolder)
          .onChange(async (value) => {
            settings.vaultFolder = value.trim() || DEFAULT_VAULT_FOLDER;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("素材库目录")
      .setDesc(
        "视频和字幕存到哪儿。笔记留在 vault 里，视频太大所以分开存 —— 不然会被 Obsidian 自己的同步和 iCloud 一起搬走。" +
          `留空就用默认位置：${defaultMediaDir()}。想存到外接硬盘或 NAS 上，直接填那边的路径。`,
      )
      .addText((text) =>
        text
          .setPlaceholder(defaultMediaDir())
          .setValue(settings.mediaDir)
          .onChange(async (value) => {
            settings.mediaDir = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName("AI 解析").setHeading();

    new Setting(containerEl)
      .setName("AI 模式")
      // 「关闭」档已撤（2026-10-12）：默认内置模型，双轨二选一 —— 留着关闭档，
      // 选了关闭的用户会在下次加载被 migrateAiMode 迁回内置，自相矛盾。
      .setDesc("内置模型 = 走服务端并按量扣余额；自定义模型 = 用你自己的密钥直连。与个人中心「账户」页的双卡选择互通，选谁用谁，默认内置模型")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("hosted", "内置模型（扣余额）")
          .addOption("byok", "自定义模型（自己的密钥）")
          .setValue(settings.aiMode)
          .onChange(async (value) => {
            // 选谁用谁（2026-10-12 拍板，见 gate.ts resolveAiRoute）：这里选的
            // 立即生效，与个人中心「账户」页的双卡点选同一份 aiMode。
            settings.aiMode = value as typeof settings.aiMode;
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    if (settings.aiMode === "byok") {
      // 表单**永远可填**（2026-10-05 用户拍板）：配置随时能存，选了 BYOK 且
      // 快照齐全即生效（见 gate.ts resolveAiRoute）。
      // ⚠️ 这里是设置页的**直存**入口：改一项 = 草稿与生效快照（byokSaved）一起写，
      // 保持"改完即生效"的老行为 —— 账户页那套「保存/编辑」锁定只在个人中心里管
      // 草稿（见 services/ai/gate.ts 的 byokUiState）。只写草稿不写快照的话，
      // 这里的改动永远不生效，是个静默坑。
      const setting = (name: string, desc?: string) => {
        const s = new Setting(containerEl).setName(name);
        if (desc) s.setDesc(desc);
        return s;
      };
      const saveByok = (patch: Partial<PluginSettings["byok"]>): void => {
        settings.byok = { ...settings.byok, ...patch };
        settings.byokSaved = { ...settings.byok };
      };
      setting("接口地址", "OpenAI 兼容端点。请求直连这里，不经过 younglook 服务器").addText((text) => {
        text.setValue(settings.byok.baseUrl);
        text.onChange(async (value) => {
          saveByok({ baseUrl: value.trim() });
          await this.plugin.saveSettings();
        });
      });

      setting("API Key", "只存在本机。导出备份时会被剔除").addText((text) => {
        text.inputEl.type = "password";
        text.setValue(settings.byok.apiKey);
        text.onChange(async (value) => {
          saveByok({ apiKey: value.trim() });
          await this.plugin.saveSettings();
        });
      });

      setting("模型").addText((text) => {
        text.setValue(settings.byok.model);
        text.onChange(async (value) => {
          saveByok({ model: value.trim() });
          await this.plugin.saveSettings();
        });
      });
    }

    if (settings.aiMode === "hosted") {
      const balance = `内置模型余额 ${yuanMilli(settings.aiBalanceMillis)}`;
      const balanceSetting = new Setting(containerEl)
        .setName(balance)
        .setDesc("按实际用量扣费（另每月 ¥2 服务费）。自定义模型不扣这里的钱，本地功能也不需要它。");
      if (!settings.authToken) {
        balanceSetting.setDesc("连接账号后才能用内置模型。登录 / 注册在网页完成，点一下去网页连接。");
        balanceSetting.addButton((button) =>
          button.setButtonText("连接账号").onClick(() => {
            this.plugin.openConnectPage();
          }),
        );
      } else {
        balanceSetting.addButton((button) =>
          button.setButtonText("去充值").onClick(() => {
            window.open(`${this.plugin.webBase()}/pricing`, "_blank");
          }),
        );
      }
    }

    new Setting(containerEl).setName("本机数据").setHeading();

    new Setting(containerEl)
      .setName("启动时打开上次的页面")
      .setDesc("插件加载后自动把上次用的页面开回来，不用自己去点图标")
      .addToggle((toggle) =>
        toggle.setValue(settings.autoOpenPage).onChange(async (value) => {
          settings.autoOpenPage = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("学习数据放在哪")
      .setDesc("素材路径、学习进度、跟读记录都只存在这台机器上（Obsidian 自己的存储里），插件升级不会清掉。")
      .addButton((button) =>
        button.setButtonText("打开学习页").onClick(() => {
          void this.plugin.activateLeaf(VIEW_TYPE_STUDY, true);
        }),
      );

    new Setting(containerEl).setName("云同步").setHeading();

    // 生产构建不给切服务端的入口，但**要显示连的是哪台** ——
    // 用户报"同步不上"时第一件事就是确认这个地址。顺带亮出构建分支，
    // 排查"线上包行为不对"时先看它是不是 master 出的包。
    if (!IS_DEV_BUILD) {
      const branchLabel = BUILD_BRANCH ? `（${BUILD_BRANCH} 分支构建）` : "";
      new Setting(containerEl).setName("服务端").setDesc(`${settings.serverUrl}${branchLabel}`);
    }

    const account = new Setting(containerEl).setName("账号");
    void this.plugin.refreshAccountSetting(account);

    new Setting(containerEl)
      .setName("自动同步间隔")
      .setDesc("分钟。学习记录会按这个间隔上报到网页端（学习看板的数字来自这里）；0 = 只在手动点「立即同步」时上报")
      .addText((text) =>
        text.setValue(String(settings.autoSyncMinutes)).onChange(async (value) => {
          const parsed = Number(value);
          settings.autoSyncMinutes = Number.isFinite(parsed) && parsed >= 0 ? parsed : 15;
          await this.plugin.saveSettings();
          // 间隔改了要立刻重启定时器，否则要等下一次重载才生效
          this.plugin.startAutoSync();
        }),
      );

    this.buildVersionInfo(containerEl);
  }

  /**
   * 「版本」—— 一块**只读**信息。
   *
   * ⚠️ 这里**没有「检查更新 / 一键更新」按钮，而且不该再加回来**：
   *    Obsidian 社区目录的开发者政策把「Install or update themselves or their
   *    dependencies」列为禁止项（2026-10-18 摘掉了整条自更新链路）。更新只走
   *    BRAT / 社区商店，由用户自己触发；插件既不检查也不下载新版本。
   */
  private buildVersionInfo(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("版本").setHeading();
    const branchLabel = BUILD_BRANCH ? `（${BUILD_BRANCH} 分支构建）` : "";
    new Setting(containerEl)
      .setName(`当前版本 ${this.plugin.manifest.version}`)
      .setDesc(
        IS_DEV_BUILD
          ? `开发构建${branchLabel}：重新构建即更新。`
          : `更新请在 Obsidian 里自己操作（BRAT 或社区插件商店），插件不会自行更新。`,
      );
  }

  /**
   * 「连哪台服务器」这一项。
   *
   * ⚠️ **只在开发构建里渲染** —— 发布出去的插件压根不该有指向本机的入口，
   * 生产构建走 `display()` 里那段只读提示就够了。
   */
  private buildServerEnvSetting(containerEl: HTMLElement): void {
    const settings = this.plugin.settings;
    const autoLabel = BUILD_ENV === "dev" ? "跟随构建（开发）" : "跟随构建（生产）";

    new Setting(containerEl)
      .setName("服务端")
      .setDesc(`当前生效：${settings.serverUrl}。改完重建或重载插件即生效。`)
      .addDropdown((dropdown) =>
        dropdown
          .addOption("auto", autoLabel)
          .addOption("dev", `本机开发 ${PRESETS.dev.api}`)
          .addOption("prod", `线上 ${PRESETS.prod.api}`)
          .addOption("custom", "自定义…")
          .setValue(settings.serverEnv)
          .onChange(async (value) => {
            settings.serverEnv = value as ServerEnv;
            await this.plugin.applyServerEnv();
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    if (settings.serverEnv !== "custom") return;

    new Setting(containerEl)
      .setName("自定义服务端地址")
      .setDesc("接口地址。网页端默认同源；填本机 8060 时网页端会用 5173。")
      .addText((text) =>
        text.setValue(settings.customServerUrl).onChange(async (value) => {
          settings.customServerUrl = value.trim().replace(/\/+$/u, "");
          await this.plugin.applyServerEnv();
          await this.plugin.saveSettings();
        }),
      );
  }
}
