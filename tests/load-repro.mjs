// 复现 Obsidian「插件加载失败」：stub 掉运行时模块，require main.js 并调 onload
import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");

class FakeEventTarget {
    constructor() { this._e = new Map(); }
    on(n, cb) { (this._e.get(n) ?? this._e.set(n, []).get(n)).push(cb); return cb; }
    off() {}
    trigger(n, ...a) { (this._e.get(n) ?? []).forEach((cb) => cb(...a)); }
}

const obsidianStub = {
    Plugin: class Plugin {
        constructor(app, manifest) { this.app = app; this.manifest = manifest; }
        async loadData() { return null; }
        async saveData() {}
        addRibbonIcon() { return { remove() {} }; }
        addSettingTab() {}
        registerView() {}
        registerEvent() {}
        registerDomEvent() {}
        registerInterval(id) { return id; }
        addCommand() { return { id: "x" }; }
        registerMarkdownPostProcessor() {}
        registerMarkdownCodeBlockProcessor() {}
        registerObsidianProtocolHandler() {}
        registerHoverLinkSource() {}
        addStatusBarItem() { return { addClass() {}, setText() {}, remove() {} }; }
        hasFocus() { return false; }
    },
    PluginSettingTab: class PluginSettingTab {
        constructor(app, plugin) { this.app = app; this.plugin = plugin; }
        display() {}
        hide() {}
    },
    Modal: class Modal {
        constructor(app) { this.app = app; }
        open() {}
        close() {}
        onOpen() {}
        onClose() {}
    },
    ItemView: class ItemView { getViewType() { return ""; } getDisplayText() { return ""; } onOpen() { return []; } onClose() { return []; } },
    Notice: class Notice { constructor(msg) { console.log("[Notice]", msg); } hide() {} },
    MarkdownView: class MarkdownView {},
    TFile: class TFile {},
    TFolder: class TFolder {},
    FileSystemAdapter: class FileSystemAdapter { getBasePath() { return pluginRoot; } },
    normalizePath: (p) => p,
    requestUrl: async () => ({ json: {}, text: "", status: 200 }),
    debounce: (fn) => fn,
    setIcon() {},
    Platform: { isDesktop: true, isMobile: false, isIosApp: false, isAndroidApp: false },
    Menu: class Menu {},
    FuzzySuggestModal: class FuzzySuggestModal {},
    SuggestModal: class SuggestModal {},
    AbstractInputSuggest: class AbstractInputSuggest {},
    Setting: class Setting {},
    Component: class Component {},
    Events: FakeEventTarget,
    TAbstractFile: class TAbstractFile {},
    addIcon() {},
};

const electronStub = {
    ipcRenderer: { invoke: async () => ({}), on() {}, send() {} },
    remote: {},
    shell: { openExternal: async () => {} },
    clipboard: { writeText() {}, readText: () => "" },
};

const parentRequire = Module.createRequire(path.join(pluginRoot, "noop.js"));
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === "obsidian") return obsidianStub;
    if (request === "electron") return electronStub;
    if (request.startsWith("@codemirror/") || request.startsWith("@lezer/")) return {};
    return origLoad.call(this, request, parent, isMain);
};

process.on("unhandledRejection", (e) => {
    console.error("\n[unhandledRejection]", e);
});

// Electron 渲染进程里有 indexedDB，Node 里没有 —— 用项目自带的 polyfill 补齐
import "fake-indexeddb/auto";

console.log("== eval main.js（按 Obsidian 的 CJS 包装方式）==");
import fs from "node:fs";
import vm from "node:vm";
const code = fs.readFileSync(path.join(pluginRoot, "main.js"), "utf8");
const fakeRequire = (request) => {
    if (request === "obsidian") return obsidianStub;
    if (request === "electron") return electronStub;
    if (request.startsWith("@codemirror/") || request.startsWith("@lezer/")) return {};
    if (request.startsWith("node:") || ["fs", "path", "os", "crypto", "util", "events", "stream", "zlib", "http", "https", "url", "child_process"].includes(request)) return parentRequire(request);
    throw new Error("unexpected require: " + request);
};
const module_ = { exports: {} };
const wrapper = vm.runInThisContext(
    "(function (module, exports, require, document, window, navigator) {\n" + code + "\n})",
    { filename: path.join(pluginRoot, "main.js") },
);
const windowStub = {
    setInterval, setTimeout, clearInterval, clearTimeout, requestAnimationFrame: (cb) => setTimeout(cb, 0),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {}, removeEventListener() {},
    location: { href: "http://localhost/", protocol: "http:", origin: "http://localhost" },
    navigator: { userAgent: "node", clipboard: { writeText: async () => {}, readText: async () => "" } },
};
const elementStub = () => ({
    style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {}, remove() {},
    createEl() { return elementStub(); }, createDiv() { return elementStub(); }, empty() {}, setText() {},
    setAttribute() {}, getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [],
    append() {}, prepend() {}, addClasses() {}, removeClasses() {}, hasClass: () => false, toggleClass() {},
    children: [], parentElement: null, tabIndex: 0, focus() {}, blur() {}, click() {}, dataset: {},
    innerText: "", textContent: "", innerHTML: "", value: "", checked: false, hidden: false,
});
const documentStub = {
    body: elementStub(), documentElement: elementStub(), head: elementStub(),
    createElement: () => elementStub(), createDocumentFragment: () => elementStub(),
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
    addEventListener() {}, removeEventListener() {}, activeElement: null,
    createTextNode: () => ({}), contains: () => false,
};
wrapper(module_, module_.exports, fakeRequire, documentStub, windowStub, windowStub.navigator);
const mod = module_.exports;
console.log("== eval OK, exports:", Object.keys(mod));

const PluginCls = mod.default;
if (!PluginCls) { console.error("!! no default export"); process.exit(1); }

const app = {
    workspace: Object.assign(new FakeEventTarget(), {
        onLayoutReady: (cb) => { cb(); },
        getLeavesOfType: () => [],
        getActiveViewOfType: () => null,
        getActiveFile: () => null,
        getMostRecentLeaf: () => null,
        getLeaf: () => ({}),
        getOpenLeaves: () => [],
        iterateAllLeaves: () => {},
        detachLeavesOfType: () => {},
        containerEl: { getGroupHeadings: () => [] },
    }),
    vault: Object.assign(new FakeEventTarget(), {
        getName: () => "test-vault",
        getRoot: () => ({}),
        adapter: { exists: async () => false, read: async () => "", write: async () => {}, mkdir: async () => {}, list: async () => { return { files: [], folders: [] }; }, getName: () => "test-vault", getBasePath: () => pluginRoot, getFullPath: (p) => path.join(pluginRoot, p) },
        getMarkdownFiles: () => [],
        getAbstractFileByPath: () => null,
        createFolder: async () => {},
        create: async () => ({}),
        read: async () => "",
        cachedRead: async () => "",
        process: async () => "",
        on: () => {},
    }),
    metadataCache: new FakeEventTarget(),
    fileManager: { generateMarkdownLink: () => "" },
    lastEvent: null,
    keymap: { pushScope() {}, popScope() {} },
    scope: {},
};
const plugin = new PluginCls(app, { id: "young-look", name: "young-look", version: "0.2.1" });
await plugin.onload();
console.log("== onload OK ==");
