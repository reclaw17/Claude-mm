//! 页面扩展：注入 Claude 页面的 js / css 包。
//!
//! 扩展包是一个文件夹 `<id>/manifest.json` + 清单里列出的文件。内置的随程序打包，装到
//! `<状态目录>/claude-local/extensions-builtin/`；用户导入的放在 `extensions/`。启用了哪些写在
//! `extensions.json`（`{"enabled": [...]}`），本地服务每次请求现读（见 runtime/extensions.mjs），
//! 开关、改文件都是刷新页面就生效。清单规则两边一致。
//!
//! 同一个目录里还能放 Codex++ 的拓展包（`<id>/codexpp.json`，页面部分写在 `claudeDesktop` 里，见 [`codexpp`]）。
//! 它们带页面接口（`window.codexPlus`）、配置和后台，注入方式见 [`plan`]。文件夹里有 `codexpp.json`
//! 就按拓展包处理，不再看 `manifest.json`（本地服务那边同样跳过这样的文件夹）。

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub mod codexpp;
pub mod config;
pub mod plan;

pub use codexpp::{
    CODEXPP_CASES, CODEXPP_MANIFEST_FILE, ClaudePage, CodexppManifest, PAGE_API_VERSION, PAGE_ROUTES, parse_claude_page,
    parse_codexpp_manifest, valid_method,
};
pub use config::ExtensionConfigField;
pub use plan::{
    HostPagePackage, PAGE_API_CONTRACT, PagePackage, PagePlan, PageTransport, page_package, page_package_keys, page_plan,
    refresh_page_plan,
};

pub(crate) const BUILTIN_DIR: &str = "extensions-builtin";
pub(crate) const USER_DIR: &str = "extensions";
const STATE_FILE: &str = "extensions.json";
/// 拓展包的配置：`{ "<id>": { 键: 值 } }`，只存用户改过的值。
const CONFIG_FILE: &str = "extension-configs.json";
/// 页面上次加载各拓展包的结果，本地服务按页面的回报写。
pub(crate) const STATUS_FILE: &str = "page-status.json";
const MAX_FILES: usize = 32;
const MAX_PACKAGE_FILES: usize = 500;
const MAX_PACKAGE_BYTES: u64 = 20 * 1024 * 1024;

/// 内置扩展（路径相对状态目录，随其它运行时资产一起安装）。
pub(crate) const BUILTIN: &[(&str, &[u8])] = &[
    (
        "extensions-builtin/desk-pet/manifest.json",
        include_bytes!("../assets/extensions/desk-pet/manifest.json"),
    ),
    (
        "extensions-builtin/desk-pet/desk-pet.js",
        include_bytes!("../assets/extensions/desk-pet/desk-pet.js"),
    ),
    (
        "extensions-builtin/wide-chat/manifest.json",
        include_bytes!("../assets/extensions/wide-chat/manifest.json"),
    ),
    (
        "extensions-builtin/wide-chat/wide-chat.js",
        include_bytes!("../assets/extensions/wide-chat/wide-chat.js"),
    ),
];

/// 读-改-写启用状态和用户扩展目录时串行。
static LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: String,
    pub description: String,
    pub scripts: Vec<String>,
    pub styles: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: String,
    pub description: String,
    pub builtin: bool,
    pub enabled: bool,
    /// 清单有问题时的原因；这样的扩展不会被注入，也不能启用。
    pub error: Option<String>,
    /// 清单格式：`manifest`（页面扩展）或 `codexpp`（Codex++ 拓展包）。
    pub format: String,
    /// 包里带了什么：`page`（页面脚本）、`styles`、`backend`（后台进程）、`mods`（Code 会话里的按钮 / 工具 / 事件）、
    /// `codexOnly`（只在 Codex++ 里生效的部分）。
    pub capabilities: Vec<String>,
    /// 要告诉用户的话（哪些部分在这里不生效、被谁顶替了）。
    pub notes: Vec<String>,
    /// 拓展包声明的配置项。
    pub config_schema: Vec<ExtensionConfigField>,
    /// 生效配置，密钥项已打码。
    pub config: Value,
    /// 页面上次加载它的结果（状态、报错、没挂上的位置）；还没在页面里跑过为 `None`。
    pub runtime: Option<Value>,
}

/// 已装的一个包：旧格式页面扩展，或 Codex++ 拓展包。
pub(crate) enum Package {
    Legacy(Manifest),
    Codexpp(CodexppManifest),
}

/// 读用户目录里的一个包。有 `codexpp.json` 就按拓展包处理。
pub(crate) fn load_user_package(dir: &Path, id: &str) -> Result<Package> {
    if !fs::symlink_metadata(dir).is_ok_and(|meta| meta.is_dir()) {
        bail!("找不到这个扩展");
    }
    if let Ok(raw) = fs::read(dir.join(CODEXPP_MANIFEST_FILE)) {
        return parse_codexpp_manifest(&raw, Some(id)).map(Package::Codexpp);
    }
    let raw = fs::read(dir.join("manifest.json")).context("缺少 manifest.json 或 codexpp.json")?;
    parse_manifest(&raw, Some(id)).map(Package::Legacy)
}

const NO_PAGE: &str = "这个拓展包没有声明 Claude 页面部分（claudeDesktop.renderer / styles），在这里没有可运行的内容";

#[derive(Deserialize)]
struct RawManifest {
    id: String,
    name: String,
    version: String,
    author: Option<String>,
    description: Option<String>,
    #[serde(default)]
    scripts: Vec<String>,
    #[serde(default)]
    styles: Vec<String>,
}

/// 长度按 UTF-16 计，与页面侧（JS 的 `.length`）一致。
fn within(text: &str, max: usize) -> bool {
    text.encode_utf16().count() <= max
}

pub fn valid_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// `主.次.修订`，可带 `-预发布` 或 `+构建` 后缀。
fn valid_version(version: &str) -> bool {
    let (core, suffix) = match version.find(['-', '+']) {
        Some(at) => (&version[..at], Some(&version[at + 1..])),
        None => (version, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
        && suffix.is_none_or(|rest| {
            !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        })
}

/// 相对路径：每段由字母数字、`_`、`-`、`.` 组成，且不以 `.` 开头（所以没有 `..`、隐藏文件）。
fn valid_file(file: &str, ext: &str) -> bool {
    within(file, 256)
        && file.ends_with(ext)
        && file.split('/').all(|segment| {
            segment
                .bytes()
                .next()
                .is_some_and(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                && segment.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.')
        })
}

/// 解析并校验清单；`expected_id` 给了时 id 必须与之相同（文件夹名）。
pub fn parse_manifest(raw: &[u8], expected_id: Option<&str>) -> Result<Manifest> {
    let raw: RawManifest = serde_json::from_slice(raw).context("manifest.json 不是有效的清单")?;
    ensure!(valid_id(&raw.id), "id「{}」不合法：只能用小写字母、数字和 -，最长 64 个字符", raw.id);
    if let Some(expected) = expected_id {
        ensure!(raw.id == expected, "清单里的 id「{}」和文件夹名「{expected}」不一致", raw.id);
    }
    ensure!(!raw.name.trim().is_empty() && within(&raw.name, 64), "name 不能为空，最长 64 个字符");
    ensure!(within(&raw.version, 64) && valid_version(&raw.version), "version「{}」不合法，应形如 1.0.0", raw.version);
    let author = raw.author.unwrap_or_default();
    ensure!(within(&author, 64), "author 最长 64 个字符");
    let description = raw.description.unwrap_or_default();
    ensure!(within(&description, 500), "description 最长 500 个字符");
    for (files, ext) in [(&raw.scripts, ".js"), (&raw.styles, ".css")] {
        ensure!(files.len() <= MAX_FILES, "scripts / styles 各最多 {MAX_FILES} 个文件");
        if let Some(bad) = files.iter().find(|file| !valid_file(file, ext)) {
            bail!("文件路径「{bad}」不合法：要用相对路径、以 {ext} 结尾，不能有隐藏文件或 ..");
        }
    }
    ensure!(!raw.scripts.is_empty() || !raw.styles.is_empty(), "scripts 和 styles 至少要有一个文件");
    Ok(Manifest {
        id: raw.id,
        name: raw.name,
        version: raw.version,
        author,
        description,
        scripts: raw.scripts,
        styles: raw.styles,
    })
}

fn builtin_manifests() -> Vec<Manifest> {
    BUILTIN
        .iter()
        .filter_map(|(path, contents)| {
            let id = path.strip_prefix("extensions-builtin/")?.strip_suffix("/manifest.json")?;
            parse_manifest(contents, Some(id)).ok()
        })
        .collect()
}

fn read_enabled(root: &Path) -> BTreeSet<String> {
    #[derive(Deserialize)]
    struct State {
        enabled: Vec<serde_json::Value>,
    }
    fs::read(root.join(STATE_FILE))
        .ok()
        .and_then(|raw| serde_json::from_slice::<State>(&raw).ok())
        .map(|state| {
            state
                .enabled
                .into_iter()
                .filter_map(|value| value.as_str().filter(|id| valid_id(id)).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn write_enabled(root: &Path, enabled: &BTreeSet<String>) -> Result<()> {
    let body = serde_json::to_vec_pretty(&serde_json::json!({ "enabled": enabled }))?;
    crate::fsutil::atomic_write(&root.join(STATE_FILE), &body)
}

fn info(manifest: Manifest, builtin: bool, enabled: &BTreeSet<String>) -> ExtensionInfo {
    let mut capabilities = Vec::new();
    if !manifest.scripts.is_empty() {
        capabilities.push("page".to_string());
    }
    if !manifest.styles.is_empty() {
        capabilities.push("styles".to_string());
    }
    ExtensionInfo {
        enabled: enabled.contains(&manifest.id),
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        author: manifest.author,
        description: manifest.description,
        builtin,
        error: None,
        format: "manifest".to_string(),
        capabilities,
        notes: Vec::new(),
        config_schema: Vec::new(),
        config: Value::Null,
        runtime: None,
    }
}

fn broken(id: String, format: &str, error: String) -> ExtensionInfo {
    ExtensionInfo {
        enabled: false,
        name: id.clone(),
        id,
        version: String::new(),
        author: String::new(),
        description: String::new(),
        builtin: false,
        error: Some(error),
        format: format.to_string(),
        capabilities: Vec::new(),
        notes: Vec::new(),
        config_schema: Vec::new(),
        config: Value::Null,
        runtime: None,
    }
}

fn codexpp_info(
    manifest: CodexppManifest,
    enabled: &BTreeSet<String>,
    stored: Option<&Map<String, Value>>,
    runtime: Option<Value>,
    shadowed: bool,
) -> ExtensionInfo {
    let Some(page) = &manifest.page else {
        return broken(manifest.id, "codexpp", NO_PAGE.to_string());
    };
    let mut capabilities = Vec::new();
    let mut notes = Vec::new();
    if !page.scripts.is_empty() {
        capabilities.push("page".to_string());
    }
    if !page.styles.is_empty() {
        capabilities.push("styles".to_string());
    }
    if manifest.backend.is_some() {
        capabilities.push("backend".to_string());
    }
    if manifest.mods {
        capabilities.push("mods".to_string());
        notes.push("Code 会话里的按钮、工具和事件在这里不生效，要装进 Codex++ 的拓展目录".to_string());
    }
    if !manifest.codex_only.is_empty() {
        capabilities.push("codexOnly".to_string());
        notes.push(format!("这些部分只在 Codex++ 里对 Codex 生效：{}", manifest.codex_only.join("、")));
    }
    if shadowed {
        notes.push("同名拓展已经装在 Codex++ 的拓展目录里，以那边的为准，这一份不会运行".to_string());
    }
    let resolved = config::resolve_extension_config(&manifest.config_schema, stored);
    let config = config::mask_secret_config(&serde_json::to_value(&manifest.config_schema).unwrap_or_default(), &resolved);
    ExtensionInfo {
        enabled: enabled.contains(&manifest.id),
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        author: manifest.author,
        description: manifest.description,
        builtin: false,
        error: None,
        format: "codexpp".to_string(),
        capabilities,
        notes,
        config_schema: manifest.config_schema,
        config,
        runtime,
    }
}

/// 只有本人可读的原子写入（配置和注入计划里可能有密钥）。
pub(crate) fn write_private(path: &Path, body: &[u8]) -> Result<()> {
    crate::fsutil::atomic_write(path, body)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

pub(crate) fn read_configs(root: &Path) -> BTreeMap<String, Map<String, Value>> {
    fs::read(root.join(CONFIG_FILE))
        .ok()
        .and_then(|raw| serde_json::from_slice::<BTreeMap<String, Value>>(&raw).ok())
        .map(|configs| {
            configs
                .into_iter()
                .filter_map(|(id, values)| match values {
                    Value::Object(values) if valid_id(&id) => Some((id, values)),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn write_configs(root: &Path, configs: &BTreeMap<String, Map<String, Value>>) -> Result<()> {
    write_private(&root.join(CONFIG_FILE), &serde_json::to_vec_pretty(configs)?)
}

/// 页面回报的加载结果：`{ "scripts": { "<key>": {...} } }`。
fn read_status(root: &Path) -> Map<String, Value> {
    fs::read(root.join(STATUS_FILE))
        .ok()
        .and_then(|raw| serde_json::from_slice::<Value>(&raw).ok())
        .and_then(|status| status.get("scripts").and_then(Value::as_object).cloned())
        .unwrap_or_default()
}

/// 内置在前，再按 id 排序。和内置同名的用户扩展被内置盖住，不列出来（页面侧同样以内置为准）。
/// `host_ids` 是宿主自己目录里启用中的拓展包：同 id 的本地包让给它。
fn list_with(root: &Path, host_ids: &BTreeSet<String>) -> Vec<ExtensionInfo> {
    let enabled = read_enabled(root);
    let configs = read_configs(root);
    let status = read_status(root);
    let mut builtin: Vec<ExtensionInfo> = builtin_manifests().into_iter().map(|m| info(m, true, &enabled)).collect();
    builtin.sort_by(|a, b| a.id.cmp(&b.id));
    let taken: BTreeSet<String> = builtin.iter().map(|item| item.id.clone()).collect();
    let mut user = Vec::new();
    for entry in fs::read_dir(root.join(USER_DIR)).into_iter().flatten().flatten() {
        let id = entry.file_name().to_string_lossy().into_owned();
        if id.starts_with('.') || taken.contains(&id) || !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let format = if entry.path().join(CODEXPP_MANIFEST_FILE).is_file() { "codexpp" } else { "manifest" };
        user.push(match load_user_package(&entry.path(), &id) {
            Ok(Package::Legacy(manifest)) => info(manifest, false, &enabled),
            Ok(Package::Codexpp(manifest)) => {
                let runtime = status.get(&format!("local:{id}")).cloned();
                codexpp_info(manifest, &enabled, configs.get(&id), runtime, host_ids.contains(&id))
            }
            Err(error) => broken(id, format, format!("{error:#}")),
        });
    }
    user.sort_by(|a, b| a.id.cmp(&b.id));
    builtin.into_iter().chain(user).collect()
}

fn list_in(root: &Path) -> Vec<ExtensionInfo> {
    list_with(root, &BTreeSet::new())
}

fn set_enabled_in(root: &Path, id: &str, on: bool) -> Result<Vec<ExtensionInfo>> {
    let _guard = LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let extension = list_in(root).into_iter().find(|item| item.id == id).context("找不到这个扩展")?;
    if on {
        if let Some(error) = &extension.error {
            bail!("「{}」的清单有问题，不能启用：{error}", extension.name);
        }
    }
    let mut enabled = read_enabled(root);
    if on {
        enabled.insert(id.to_string());
    } else {
        enabled.remove(id);
    }
    write_enabled(root, &enabled)?;
    Ok(list_in(root))
}

fn remove_in(root: &Path, id: &str) -> Result<String> {
    let _guard = LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let extension = list_in(root).into_iter().find(|item| item.id == id).context("找不到这个扩展")?;
    ensure!(!extension.builtin, "内置扩展不能删除，不用的话关掉即可");
    fs::remove_dir_all(root.join(USER_DIR).join(id)).context("删除扩展文件夹失败")?;
    let mut enabled = read_enabled(root);
    if enabled.remove(id) {
        write_enabled(root, &enabled)?;
    }
    // 配置里可能有密钥，跟着包一起删；后台存的数据（extension-data/<id>）留着，重装还在。
    let mut configs = read_configs(root);
    if configs.remove(id).is_some() {
        write_configs(root, &configs)?;
    }
    Ok(extension.name)
}

/// 保存一个拓展包的配置：只收清单里声明过的键，值要合乎类型；密钥项传回打码值时保留原值。
fn set_config_in(root: &Path, id: &str, values: &Map<String, Value>) -> Result<Vec<ExtensionInfo>> {
    let _guard = LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let manifest = match load_user_package(&root.join(USER_DIR).join(id), id) {
        Ok(Package::Codexpp(manifest)) => manifest,
        Ok(Package::Legacy(_)) => bail!("这个扩展没有可以设置的配置项"),
        Err(error) => bail!("清单有问题，不能保存配置：{error:#}"),
    };
    let mut configs = read_configs(root);
    let merged = config::merge_config_values(&manifest.config_schema, configs.get(id), values);
    config::validate_config_values(&manifest.config_schema, &merged)?;
    configs.insert(id.to_string(), merged);
    write_configs(root, &configs)?;
    Ok(list_in(root))
}

/// 导入结果：清单，以及被覆盖的旧版本（之前没装过为 `None`）。
pub struct Imported {
    /// 拓展包（`codexpp.json`）也整理成这个形状：`scripts` / `styles` 是它的页面部分。
    pub manifest: Manifest,
    pub replaced: Option<String>,
    /// `manifest` 或 `codexpp`。
    pub format: &'static str,
    /// 带后台进程：启用后会以当前用户身份运行包里的 Node 脚本。
    pub backend: bool,
}

/// `source` 是扩展包的 .zip、扩展文件夹，或文件夹里的 manifest.json / codexpp.json。
/// 先解到 `extensions/.import-*`，校验通过再整个换进 `extensions/<id>`；同 id 的直接覆盖。
fn import_in(root: &Path, source: &Path) -> Result<Imported> {
    let _guard = LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let user = root.join(USER_DIR);
    crate::private_dir(&user)?;
    let staging = user.join(format!(".import-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let is_zip = source.is_file()
            && source.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("zip"));
        if is_zip {
            extract_zip(source, &staging)?;
        } else {
            let dir = if source.is_dir() {
                source
            } else if source.file_name().is_some_and(|name| name == "manifest.json" || name == CODEXPP_MANIFEST_FILE) {
                source.parent().context("找不到扩展文件夹")?
            } else {
                bail!("请选择扩展包的 .zip，或扩展文件夹里的 manifest.json / codexpp.json");
            };
            fs::create_dir_all(&staging)?;
            let mut budget = Budget::default();
            copy_tree(dir, &staging, &mut budget)?;
        }
        let package = package_root(&staging)?;
        let (manifest, format, backend) = match fs::read(package.join(CODEXPP_MANIFEST_FILE)) {
            Ok(raw) => {
                let parsed = parse_codexpp_manifest(&raw, None)?;
                let page = parsed.page.context(NO_PAGE)?;
                let manifest = Manifest {
                    id: parsed.id,
                    name: parsed.name,
                    version: parsed.version,
                    author: parsed.author,
                    description: parsed.description,
                    scripts: page.scripts,
                    styles: page.styles,
                };
                (manifest, "codexpp", parsed.backend)
            }
            Err(_) => (parse_manifest(&fs::read(package.join("manifest.json"))?, None)?, "manifest", None),
        };
        ensure!(
            !builtin_manifests().iter().any(|builtin| builtin.id == manifest.id),
            "「{}」和内置扩展同 id，请在清单里换一个 id",
            manifest.id
        );
        for file in manifest.scripts.iter().chain(&manifest.styles).chain(&backend) {
            ensure!(
                fs::symlink_metadata(package.join(file)).is_ok_and(|meta| meta.is_file()),
                "清单里列的 {file} 不在扩展包里"
            );
        }
        let target = user.join(&manifest.id);
        let replaced = match load_user_package(&target, &manifest.id) {
            Ok(Package::Legacy(old)) => Some(old.version),
            Ok(Package::Codexpp(old)) => Some(old.version),
            Err(_) => None,
        };
        if fs::symlink_metadata(&target).is_ok() {
            fs::remove_dir_all(&target).context("替换旧版本失败")?;
        }
        fs::rename(&package, &target).context("安装扩展失败")?;
        Ok(Imported { manifest, replaced, format, backend: backend.is_some() })
    })();
    let _ = fs::remove_dir_all(&staging);
    result
}

/// 扩展包大小上限：文件数和总字节。
#[derive(Default)]
struct Budget {
    files: usize,
    bytes: u64,
}

impl Budget {
    fn take(&mut self, bytes: u64) -> Result<()> {
        self.files += 1;
        self.bytes += bytes;
        ensure!(
            self.files <= MAX_PACKAGE_FILES && self.bytes <= MAX_PACKAGE_BYTES,
            "扩展包太大：最多 {MAX_PACKAGE_FILES} 个文件、{} MB",
            MAX_PACKAGE_BYTES / 1024 / 1024
        );
        Ok(())
    }
}

/// 不复制的条目：隐藏文件（.git、.DS_Store）和 macOS 压缩时附带的 __MACOSX。
fn skipped(name: &str) -> bool {
    name.starts_with('.') || name == "__MACOSX"
}

/// 只复制普通文件和文件夹，符号链接一律跳过。
fn copy_tree(from: &Path, to: &Path, budget: &mut Budget) -> Result<()> {
    for entry in fs::read_dir(from).with_context(|| format!("读不了 {}", from.display()))? {
        let entry = entry?;
        let name = entry.file_name();
        if skipped(&name.to_string_lossy()) {
            continue;
        }
        let kind = entry.file_type()?;
        let target = to.join(&name);
        if kind.is_dir() {
            fs::create_dir_all(&target)?;
            copy_tree(&entry.path(), &target, budget)?;
        } else if kind.is_file() {
            budget.take(entry.metadata()?.len())?;
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

fn extract_zip(source: &Path, to: &Path) -> Result<()> {
    let mut archive = zip::ZipArchive::new(File::open(source)?).context("不是有效的 zip 文件")?;
    fs::create_dir_all(to)?;
    let mut budget = Budget::default();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        let relative = entry
            .enclosed_name()
            .with_context(|| format!("扩展包里有不安全的路径：{}", entry.name()))?;
        if relative.components().any(|part| skipped(&part.as_os_str().to_string_lossy())) {
            continue;
        }
        let target = to.join(&relative);
        if entry.is_dir() {
            fs::create_dir_all(&target)?;
            continue;
        }
        // 符号链接（unix 模式 0o120000）跳过。
        if entry.unix_mode().is_some_and(|mode| mode & 0o170000 == 0o120000) {
            continue;
        }
        budget.take(entry.size())?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut contents = Vec::new();
        (&mut entry).take(MAX_PACKAGE_BYTES + 1).read_to_end(&mut contents)?;
        ensure!(contents.len() as u64 <= MAX_PACKAGE_BYTES, "扩展包太大");
        File::create(&target)?.write_all(&contents)?;
    }
    Ok(())
}

/// 清单（manifest.json 或 codexpp.json）在解开的根上，或在唯一的一层文件夹里（打包时把文件夹本身也压进去了）。
fn package_root(staging: &Path) -> Result<PathBuf> {
    let has_manifest = |dir: &Path| dir.join("manifest.json").is_file() || dir.join(CODEXPP_MANIFEST_FILE).is_file();
    if has_manifest(staging) {
        return Ok(staging.to_path_buf());
    }
    let entries: Vec<PathBuf> = fs::read_dir(staging)?.flatten().map(|entry| entry.path()).collect();
    match entries.as_slice() {
        [only] if only.is_dir() && has_manifest(only) => Ok(only.clone()),
        _ => bail!("扩展包里没有 manifest.json 或 codexpp.json"),
    }
}

fn host_ids() -> BTreeSet<String> {
    crate::host::page_packages().into_iter().map(|package| package.id).collect()
}

/// 已装的扩展：内置在前。顺带重新生成注入计划（手改了包里的清单，刷新一下列表就会生效）。
pub fn list() -> Vec<ExtensionInfo> {
    refresh_page_plan();
    list_with(&crate::backend::root_dir(), &host_ids())
}

pub fn set_enabled(id: &str, enabled: bool) -> Result<Vec<ExtensionInfo>> {
    set_enabled_in(&crate::backend::root_dir(), id, enabled)?;
    Ok(list())
}

pub fn import(source: &Path) -> Result<Imported> {
    let imported = import_in(&crate::backend::root_dir(), source)?;
    refresh_page_plan();
    Ok(imported)
}

/// 删除一个用户扩展，返回它的名称。
pub fn remove(id: &str) -> Result<String> {
    let name = remove_in(&crate::backend::root_dir(), id)?;
    refresh_page_plan();
    Ok(name)
}

/// 保存一个拓展包的配置，返回更新后的列表。
pub fn set_config(id: &str, values: &Map<String, Value>) -> Result<Vec<ExtensionInfo>> {
    set_config_in(&crate::backend::root_dir(), id, values)?;
    Ok(list())
}

/// 要注入页面的一个文件。`style` 为真是 css，否则是 js。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PageAsset {
    pub id: String,
    pub file: String,
    pub style: bool,
    pub body: String,
}

/// 启用中的扩展要注入的文件，顺序和本地服务插标签的一样：按 id，每个扩展先样式后脚本。
/// 给不经本地服务的注入方式用（Codex++ 的补丁副本在主进程里注入）；取文件的规则同
/// runtime/extensions.mjs 的 `read`：内置的优先，只取清单里列的，不跟符号链接，不出扩展自己的文件夹。
pub fn enabled_assets() -> Vec<PageAsset> {
    enabled_assets_in(&crate::backend::root_dir())
}

fn enabled_assets_in(root: &Path) -> Vec<PageAsset> {
    let builtin = builtin_manifests();
    let mut assets = Vec::new();
    for id in read_enabled(root) {
        let dir = root.join(USER_DIR).join(&id);
        let shipped = builtin.iter().find(|manifest| manifest.id == id);
        let manifest = match shipped {
            Some(manifest) => manifest.clone(),
            // 拓展包（codexpp.json）不走这条路，见 plan。
            None => match load_user_package(&dir, &id) {
                Ok(Package::Legacy(manifest)) => manifest,
                _ => continue,
            },
        };
        let files = manifest.styles.iter().map(|file| (file, true)).chain(manifest.scripts.iter().map(|file| (file, false)));
        for (file, style) in files {
            let body = if shipped.is_some() { builtin_file(&id, file) } else { user_file(&dir, file) };
            if let Some(body) = body.and_then(|body| String::from_utf8(body).ok()) {
                assets.push(PageAsset { id: id.clone(), file: file.clone(), style, body });
            }
        }
    }
    assets
}

pub(crate) fn builtin_file(id: &str, file: &str) -> Option<Vec<u8>> {
    let path = format!("{BUILTIN_DIR}/{id}/{file}");
    BUILTIN.iter().find(|(name, _)| *name == path).map(|(_, body)| body.to_vec())
}

fn user_file(dir: &Path, file: &str) -> Option<Vec<u8>> {
    let path = dir.join(file);
    if !fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_file()) {
        return None;
    }
    let real = path.canonicalize().ok()?;
    if !real.starts_with(dir.canonicalize().ok()?) {
        return None;
    }
    fs::read(real).ok()
}

/// 页面回报的加载结果，按脚本 key（本库目录里的包是 `local:<id>`，宿主的包是宿主的 key）。
pub fn page_status() -> Map<String, Value> {
    read_status(&crate::backend::root_dir())
}

/// 记下页面回报的加载结果。完整功能模式下本地服务自己写这个文件；补丁副本没有本地服务，由宿主收到回报后调这里。
pub fn record_page_status(status: &Value) -> Result<()> {
    let root = crate::backend::root_dir();
    crate::private_dir(&root)?;
    write_private(&root.join(STATUS_FILE), &serde_json::to_vec(&clean_status(status))?)
}

/// 页面回报的内容只留认识的字段、截到合理的长度（规则同 runtime/page-api.mjs 的 cleanStatus）：
/// 回报来自页面，页面里什么脚本都能发。
fn clean_status(status: &Value) -> Value {
    fn cut(text: &str, max: usize) -> String {
        text.chars().take(max).collect()
    }
    let mut scripts = Map::new();
    for (key, value) in status.get("scripts").and_then(Value::as_object).into_iter().flatten().take(128) {
        let Some(record) = value.as_object().filter(|_| key.chars().count() <= 160) else {
            continue;
        };
        let state = record.get("status").and_then(Value::as_str).filter(|state| ["pending", "loading", "loaded", "failed"].contains(state));
        let unsupported: Vec<String> = record
            .get("unsupported")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .take(64)
            .map(|item| cut(item, 120))
            .collect();
        scripts.insert(
            key.clone(),
            serde_json::json!({
                "status": state.unwrap_or("pending"),
                "error": cut(record.get("error").and_then(Value::as_str).unwrap_or_default(), 4000),
                "unsupported": unsupported,
                "loadedAt": cut(record.get("loadedAt").and_then(Value::as_str).unwrap_or_default(), 40),
            }),
        );
    }
    let mut mounts = Map::new();
    for (name, value) in status.get("mounts").and_then(Value::as_object).into_iter().flatten().take(128) {
        if name.chars().count() > 120 {
            continue;
        }
        match value {
            Value::String(text) => mounts.insert(name.clone(), Value::String(cut(text, 200))),
            Value::Bool(_) | Value::Number(_) => mounts.insert(name.clone(), value.clone()),
            _ => None,
        };
    }
    serde_json::json!({ "scripts": scripts, "mounts": mounts })
}

/// 运行拓展后台的 Node 脚本（`runtime/ext-backend-runner.mjs`）。宿主自己托管后台时也用这一份，
/// 后台脚本拿到的 `ctx` 两边才一致。
pub const BACKEND_RUNNER_JS: &str = include_str!("../runtime/ext-backend-runner.mjs");

/// 在访达 / 资源管理器里打开用户扩展文件夹。
pub fn open_folder() -> Result<()> {
    let dir = crate::backend::root_dir().join(USER_DIR);
    crate::private_dir(&dir)?;
    Command::new(if cfg!(windows) { "explorer" } else { "/usr/bin/open" })
        .arg(&dir)
        .spawn()
        .context("无法打开扩展文件夹")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(id: &str, version: &str) -> String {
        serde_json::json!({ "id": id, "name": "Theme", "version": version, "scripts": ["main.js"], "styles": ["css/a.css"] })
            .to_string()
    }

    fn write_package(dir: &Path, id: &str, version: &str) {
        fs::create_dir_all(dir.join("css")).unwrap();
        fs::write(dir.join("manifest.json"), manifest(id, version)).unwrap();
        fs::write(dir.join("main.js"), "window.main = 1;").unwrap();
        fs::write(dir.join("css/a.css"), "body{}").unwrap();
    }

    #[test]
    fn manifests_follow_the_page_side_rules() {
        let ok = parse_manifest(manifest("theme", "1.2.3-beta.1").as_bytes(), Some("theme")).unwrap();
        assert_eq!((ok.name.as_str(), ok.author.as_str()), ("Theme", ""));
        assert!(parse_manifest(manifest("theme", "1.0.0").as_bytes(), Some("other")).is_err());
        for bad_id in ["Theme", "-x", "a_b", ""] {
            assert!(parse_manifest(manifest(bad_id, "1.0.0").as_bytes(), None).is_err(), "{bad_id}");
        }
        for bad_version in ["1.0", "v1.0.0", "1.0.0-", "1.0.0 beta"] {
            assert!(parse_manifest(manifest("theme", bad_version).as_bytes(), None).is_err(), "{bad_version}");
        }
        for bad_file in ["../x.js", ".hidden.js", "a/../b.js", "/abs.js", "x.css", "a//b.js"] {
            let raw = serde_json::json!({ "id": "x", "name": "X", "version": "1.0.0", "scripts": [bad_file] }).to_string();
            assert!(parse_manifest(raw.as_bytes(), None).is_err(), "{bad_file}");
        }
        let empty = serde_json::json!({ "id": "x", "name": "X", "version": "1.0.0" }).to_string();
        assert!(parse_manifest(empty.as_bytes(), None).is_err());
        let wrong_type = serde_json::json!({ "id": "x", "name": "X", "version": "1.0.0", "scripts": "a.js" }).to_string();
        assert!(parse_manifest(wrong_type.as_bytes(), None).is_err());
    }

    #[test]
    fn builtin_extensions_are_valid_and_complete() {
        let builtin = builtin_manifests();
        assert_eq!(builtin.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["desk-pet", "wide-chat"]);
        for manifest in &builtin {
            for file in manifest.scripts.iter().chain(&manifest.styles) {
                let path = format!("extensions-builtin/{}/{file}", manifest.id);
                assert!(BUILTIN.iter().any(|(name, _)| *name == path), "{path}");
            }
        }
    }

    #[test]
    fn import_from_a_folder_lists_enables_replaces_and_removes() {
        let root = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        write_package(source.path(), "theme", "1.0.0");
        fs::write(source.path().join(".DS_Store"), "x").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc/hosts", source.path().join("link.js")).unwrap();

        let imported = import_in(root.path(), &source.path().join("manifest.json")).unwrap();
        assert_eq!((imported.manifest.id.as_str(), imported.replaced), ("theme", None));
        let installed = root.path().join("extensions/theme");
        assert!(installed.join("css/a.css").is_file());
        assert!(!installed.join(".DS_Store").exists());
        assert!(fs::symlink_metadata(installed.join("link.js")).is_err());

        let list = list_in(root.path());
        assert_eq!(list.iter().map(|item| (item.id.as_str(), item.builtin)).collect::<Vec<_>>(),
            [("desk-pet", true), ("wide-chat", true), ("theme", false)]);
        assert!(list.iter().all(|item| !item.enabled));

        let list = set_enabled_in(root.path(), "theme", true).unwrap();
        assert!(list.iter().find(|item| item.id == "theme").unwrap().enabled);
        let list = set_enabled_in(root.path(), "desk-pet", true).unwrap();
        assert!(list.iter().find(|item| item.id == "desk-pet").unwrap().enabled);
        assert_eq!(read_enabled(root.path()).into_iter().collect::<Vec<_>>(), ["desk-pet", "theme"]);

        write_package(source.path(), "theme", "1.1.0");
        let imported = import_in(root.path(), source.path()).unwrap();
        assert_eq!(imported.replaced.as_deref(), Some("1.0.0"));
        let theme = list_in(root.path()).into_iter().find(|item| item.id == "theme").unwrap();
        assert_eq!((theme.version.as_str(), theme.enabled), ("1.1.0", true));

        assert!(remove_in(root.path(), "desk-pet").is_err());
        assert_eq!(remove_in(root.path(), "theme").unwrap(), "Theme");
        assert!(!installed.exists());
        assert_eq!(read_enabled(root.path()).into_iter().collect::<Vec<_>>(), ["desk-pet"]);
        assert!(set_enabled_in(root.path(), "theme", true).is_err());
    }

    #[test]
    fn import_rejects_bad_packages_and_leaves_nothing_behind() {
        let root = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        write_package(source.path(), "desk-pet", "1.0.0");
        assert!(import_in(root.path(), source.path()).is_err(), "和内置同 id");
        write_package(source.path(), "theme", "1.0.0");
        fs::remove_file(source.path().join("main.js")).unwrap();
        assert!(import_in(root.path(), source.path()).is_err(), "清单里的文件缺了");
        let stray = tempfile::tempdir().unwrap();
        fs::write(stray.path().join("readme.txt"), "x").unwrap();
        assert!(import_in(root.path(), &stray.path().join("readme.txt")).is_err());
        let left: Vec<_> = fs::read_dir(root.path().join("extensions")).unwrap().flatten().collect();
        assert!(left.is_empty(), "{left:?}");
    }

    #[test]
    fn broken_user_extensions_are_listed_with_their_error_and_cannot_be_enabled() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("extensions/broken");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("manifest.json"), manifest("other", "1.0.0")).unwrap();
        let broken = list_in(root.path()).into_iter().find(|item| item.id == "broken").unwrap();
        assert!(broken.error.as_deref().unwrap().contains("不一致"));
        assert!(set_enabled_in(root.path(), "broken", true).is_err());
        assert!(set_enabled_in(root.path(), "broken", false).is_ok());
    }

    fn write_codexpp(dir: &Path, id: &str, extra: serde_json::Value) {
        fs::create_dir_all(dir.join("backend")).unwrap();
        let mut manifest = serde_json::json!({
            "id": id,
            "name": "Demo",
            "version": "2.0.0",
            "backend": { "script": "backend/main.mjs" },
            "config": { "minutes": { "type": "number", "default": 5 }, "token": { "type": "string", "secret": true } },
            "claudeDesktop": { "renderer": "main.js", "styles": ["css/a.css"], "methods": ["status"] },
        });
        manifest.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        fs::write(dir.join(CODEXPP_MANIFEST_FILE), manifest.to_string()).unwrap();
        fs::create_dir_all(dir.join("css")).unwrap();
        fs::write(dir.join("main.js"), "window.demo = 1;").unwrap();
        fs::write(dir.join("css/a.css"), "body{}").unwrap();
        fs::write(dir.join("backend/main.mjs"), "export default () => ({});").unwrap();
    }

    #[test]
    fn codexpp_packages_sit_in_the_same_list_as_page_extensions() {
        let root = tempfile::tempdir().unwrap();
        let theme = tempfile::tempdir().unwrap();
        write_package(theme.path(), "theme", "1.0.0");
        import_in(root.path(), theme.path()).unwrap();
        let demo = tempfile::tempdir().unwrap();
        write_codexpp(demo.path(), "demo", serde_json::json!({ "hooks": { "session-start": [] } }));
        let imported = import_in(root.path(), &demo.path().join(CODEXPP_MANIFEST_FILE)).unwrap();
        assert_eq!((imported.format, imported.backend, imported.replaced), ("codexpp", true, None));
        assert_eq!((imported.manifest.scripts.as_slice(), imported.manifest.styles.as_slice()), (&["main.js".to_string()][..], &["css/a.css".to_string()][..]));

        let list = list_in(root.path());
        let formats: Vec<_> = list.iter().map(|item| (item.id.as_str(), item.format.as_str())).collect();
        assert_eq!(formats, [("desk-pet", "manifest"), ("wide-chat", "manifest"), ("demo", "codexpp"), ("theme", "manifest")]);
        let item = list.iter().find(|item| item.id == "demo").unwrap();
        assert_eq!(item.capabilities, ["page", "styles", "backend", "codexOnly"]);
        assert!(item.notes[0].contains("hooks"), "{:?}", item.notes);
        assert_eq!(item.config, serde_json::json!({ "minutes": 5, "token": "" }));
        assert_eq!(item.config_schema.len(), 2);
        assert_eq!(item.runtime, None);
        assert_eq!(list.iter().find(|item| item.id == "theme").unwrap().capabilities, ["page", "styles"]);

        // 页面回报过加载结果后列表带上它；宿主目录里有同名包时标出来。
        fs::write(root.path().join(STATUS_FILE), r#"{"scripts":{"local:demo":{"status":"failed","error":"boom"}}}"#).unwrap();
        let shadowed = list_with(root.path(), &["demo".to_string()].into());
        let item = shadowed.iter().find(|item| item.id == "demo").unwrap();
        assert_eq!(item.runtime.as_ref().unwrap()["error"], "boom");
        assert!(item.notes.iter().any(|note| note.contains("以那边的为准")));

        // 旧格式的注入不带拓展包。
        set_enabled_in(root.path(), "demo", true).unwrap();
        set_enabled_in(root.path(), "theme", true).unwrap();
        assert!(enabled_assets_in(root.path()).iter().all(|asset| asset.id == "theme"));
    }

    #[test]
    fn codexpp_config_is_validated_kept_across_reimport_and_removed_with_the_package() {
        let root = tempfile::tempdir().unwrap();
        let demo = tempfile::tempdir().unwrap();
        write_codexpp(demo.path(), "demo", serde_json::json!({}));
        import_in(root.path(), demo.path()).unwrap();
        let values = |value: serde_json::Value| value.as_object().unwrap().clone();

        assert!(set_config_in(root.path(), "demo", &values(serde_json::json!({ "minutes": "x" }))).is_err());
        assert!(set_config_in(root.path(), "demo", &values(serde_json::json!({ "nope": 1 }))).is_err());
        assert!(set_config_in(root.path(), "wide-chat", &values(serde_json::json!({}))).is_err());
        let list = set_config_in(root.path(), "demo", &values(serde_json::json!({ "minutes": 9, "token": "sk-1" }))).unwrap();
        let item = list.iter().find(|item| item.id == "demo").unwrap();
        assert_eq!(item.config, serde_json::json!({ "minutes": 9, "token": config::SECRET_MASK }));
        // 界面把打码值原样传回来：密钥保留。
        set_config_in(root.path(), "demo", &values(serde_json::json!({ "minutes": 3, "token": config::SECRET_MASK }))).unwrap();
        assert_eq!(read_configs(root.path())["demo"]["token"], "sk-1");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(root.path().join(CONFIG_FILE)).unwrap().permissions().mode() & 0o777, 0o600);
        }

        write_codexpp(demo.path(), "demo", serde_json::json!({ "version": "2.1.0" }));
        let imported = import_in(root.path(), demo.path()).unwrap();
        assert_eq!(imported.replaced.as_deref(), Some("2.0.0"));
        assert_eq!(read_configs(root.path())["demo"]["minutes"], 3);

        remove_in(root.path(), "demo").unwrap();
        assert!(read_configs(root.path()).is_empty());
    }

    #[test]
    fn codexpp_packages_that_cannot_run_here_are_rejected_or_listed_with_the_reason() {
        let root = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        write_codexpp(source.path(), "Demo_1", serde_json::json!({}));
        let error = import_in(root.path(), source.path()).err().unwrap();
        assert!(format!("{error:#}").contains("小写"), "{error:#}");
        write_codexpp(source.path(), "demo", serde_json::json!({ "claudeDesktop": { "buttons": [{ "id": "a", "label": "A", "method": "status" }] } }));
        let error = import_in(root.path(), source.path()).err().unwrap();
        assert!(format!("{error:#}").contains("页面部分"), "{error:#}");
        write_codexpp(source.path(), "demo", serde_json::json!({}));
        fs::remove_file(source.path().join("backend/main.mjs")).unwrap();
        assert!(import_in(root.path(), source.path()).is_err(), "后台脚本缺了");
        let left: Vec<_> = fs::read_dir(root.path().join("extensions")).unwrap().flatten().collect();
        assert!(left.is_empty(), "{left:?}");

        // 手放进目录的包：没有页面部分的列出来并说明原因，不能启用。
        let dir = root.path().join("extensions/mods-only");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(CODEXPP_MANIFEST_FILE), r#"{ "id": "mods-only", "backend": { "script": "b.mjs" }, "claudeDesktop": { "buttons": [] } }"#).unwrap();
        // 同一个文件夹里还有 manifest.json 也不回退：有 codexpp.json 就按拓展包处理。
        fs::write(dir.join("manifest.json"), manifest("mods-only", "1.0.0")).unwrap();
        let item = list_in(root.path()).into_iter().find(|item| item.id == "mods-only").unwrap();
        assert_eq!(item.format, "codexpp");
        assert!(item.error.as_deref().unwrap().contains("页面部分"));
        assert!(set_enabled_in(root.path(), "mods-only", true).is_err());
    }

    #[test]
    fn page_status_keeps_only_known_fields() {
        let cleaned = clean_status(&serde_json::json!({
            "scripts": {
                "local:demo": { "status": "failed", "error": "x".repeat(9000), "unsupported": ["registerSlot:a", 3], "extra": 1 },
                "local:odd": { "status": "weird" },
                "local:not-object": 3,
            },
            "mounts": { "rail": "ok", "count": 2, "bad": {} },
            "other": true,
        }));
        assert_eq!(cleaned["scripts"]["local:demo"]["error"].as_str().unwrap().len(), 4000);
        assert_eq!(cleaned["scripts"]["local:demo"]["unsupported"], serde_json::json!(["registerSlot:a"]));
        assert!(cleaned["scripts"]["local:demo"].get("extra").is_none());
        assert_eq!(cleaned["scripts"]["local:odd"]["status"], "pending");
        assert!(cleaned["scripts"].get("local:not-object").is_none());
        assert_eq!(cleaned["mounts"], serde_json::json!({ "rail": "ok", "count": 2 }));
        assert!(cleaned.get("other").is_none());
    }

    #[test]
    fn enabled_assets_follow_the_page_injection_order_and_rules() {
        let root = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        write_package(source.path(), "theme", "1.0.0");
        import_in(root.path(), source.path()).unwrap();
        assert!(enabled_assets_in(root.path()).is_empty());

        set_enabled_in(root.path(), "theme", true).unwrap();
        set_enabled_in(root.path(), "wide-chat", true).unwrap();
        let assets = enabled_assets_in(root.path());
        let order: Vec<_> = assets.iter().map(|asset| (asset.id.as_str(), asset.file.as_str(), asset.style)).collect();
        assert_eq!(order, [("theme", "css/a.css", true), ("theme", "main.js", false), ("wide-chat", "wide-chat.js", false)]);
        assert_eq!(assets[1].body, "window.main = 1;");
        assert!(assets[2].body.contains("transcript-width"), "内置扩展取随程序打包的那份");

        // 指到扩展文件夹外的符号链接不取。
        #[cfg(unix)]
        {
            let main = root.path().join("extensions/theme/main.js");
            fs::remove_file(&main).unwrap();
            std::os::unix::fs::symlink("/etc/hosts", &main).unwrap();
            let files: Vec<_> = enabled_assets_in(root.path()).into_iter().map(|asset| asset.file).collect();
            assert_eq!(files, ["css/a.css", "wide-chat.js"]);
        }
    }

    #[test]
    fn import_from_zip_accepts_a_wrapping_folder_and_refuses_unsafe_paths() {
        use zip::write::SimpleFileOptions;
        let root = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let write_zip = |name: &str, entries: &[(&str, &str)]| {
            let path = work.path().join(name);
            let mut writer = zip::ZipWriter::new(File::create(&path).unwrap());
            let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
            for (entry, body) in entries {
                writer.start_file(*entry, options).unwrap();
                writer.write_all(body.as_bytes()).unwrap();
            }
            writer.finish().unwrap();
            path
        };
        let theme = manifest("theme", "2.0.0");
        let good = write_zip("theme.ZIP", &[
            ("theme/manifest.json", &theme),
            ("theme/main.js", "window.main = 1;"),
            ("theme/css/a.css", "body{}"),
            ("__MACOSX/theme/._main.js", "junk"),
        ]);
        let imported = import_in(root.path(), &good).unwrap();
        assert_eq!(imported.manifest.version, "2.0.0");
        assert!(root.path().join("extensions/theme/main.js").is_file());

        let evil = write_zip("evil.zip", &[("manifest.json", &theme), ("../escaped.js", "bad")]);
        assert!(import_in(root.path(), &evil).is_err());
        assert!(!root.path().join("escaped.js").exists());
        let none = write_zip("none.zip", &[("readme.txt", "x")]);
        assert!(import_in(root.path(), &none).is_err());
    }
}
