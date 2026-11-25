//! `codexpp.json`（Codex++「万物皆拓展」的清单）里和 Claude 页面有关的部分。
//!
//! 页面部分写在 `claudeDesktop` 块里：`renderer`（注入页面的脚本）、`styles`（样式）、
//! `methods`（页面可以调用的后台方法）。这三个字段的规则只有这一份：Codex++ 解析自己目录里的
//! 拓展包时也调 [`parse_claude_page`]。两个仓库各跑一遍 [`CODEXPP_CASES`]，结果必须一致。
//!
//! 清单里其余的能力（顶层 `renderer`、`hooks`、`gateway`、`tools`、`skills` 等）只在 Codex++ 里生效，
//! 这里不解析，只记下出现了哪些，界面上据此提示。

use anyhow::{Context, Result, bail, ensure};
use serde::Serialize;
use serde_json::{Map, Value};

use super::config::{ExtensionConfigField, parse_extension_config_schema};
use super::{MAX_FILES, valid_file, valid_id, within};

pub const CODEXPP_MANIFEST_FILE: &str = "codexpp.json";

/// 页面接口版本（`engines.codexpp` 写整数时比的就是它），与 Codex++ 的 `EXTENSION_API_VERSION` 相同。
pub const PAGE_API_VERSION: u64 = 1;

/// Claude 页面里开放给拓展的后端路由；拓展还得在清单 `permissions.routes` 里声明才能调。
pub const PAGE_ROUTES: &[&str] = &["/diagnostics/log", "/backend/status"];

/// 两个仓库共用的清单用例：`[{ name, claudeDesktop, page }]`，`page` 为 `null` 表示应当报错，
/// `false` 表示没有页面部分。
pub const CODEXPP_CASES: &str = include_str!("../../runtime/fixtures/codexpp-cases.json");

const MAX_METHODS: usize = 64;

/// 只在 Codex++ 里生效的顶层字段。
const CODEX_ONLY_FIELDS: &[&str] = &[
    "renderer", "preload", "launch", "hooks", "toolPipeline", "gateway", "providers", "tools", "schedules", "skills",
    "agents", "mcpServers", "instructions", "prompts", "resources", "replaces", "manager", "dsh", "settings", "instances",
];

/// `claudeDesktop` 里的页面部分。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudePage {
    /// 注入页面的脚本，按顺序拼在同一个作用域里执行。
    pub scripts: Vec<String>,
    pub styles: Vec<String>,
    /// 页面可以调用的后台方法（`ctx.backend.call`）。
    pub methods: Vec<String>,
}

impl ClaudePage {
    pub fn permits(&self, method: &str) -> bool {
        valid_method(method) && self.methods.iter().any(|declared| declared == method)
    }
}

/// 后台方法名：字母、数字、`_`、`-`、`.`，最长 128；`__` 开头的和原型上的名字不能调。
pub fn valid_method(method: &str) -> bool {
    !method.is_empty()
        && method.len() <= 128
        && !method.starts_with("__")
        && !matches!(method, "constructor" | "prototype")
        && method.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

fn strings(value: Option<&Value>, name: &str, allow_single: bool) -> Result<Vec<String>> {
    match value {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::String(single)) if allow_single => Ok(vec![single.clone()]),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| item.as_str().map(str::to_owned))
            .collect::<Option<Vec<_>>>()
            .with_context(|| format!("claudeDesktop.{name} 只能是字符串数组")),
        Some(_) => bail!("claudeDesktop.{name} 只能是字符串数组"),
    }
}

/// 解析 `claudeDesktop` 里的页面部分。三个字段都没写时返回 `None`（这个包没有页面部分）。
pub fn parse_claude_page(claude_desktop: &Value) -> Result<Option<ClaudePage>> {
    let block = claude_desktop.as_object().context("claudeDesktop 必须是对象")?;
    if !["renderer", "styles", "methods"].iter().any(|name| block.get(*name).is_some_and(|value| !value.is_null())) {
        return Ok(None);
    }
    let scripts = strings(block.get("renderer"), "renderer", true)?;
    let styles = strings(block.get("styles"), "styles", false)?;
    let methods = strings(block.get("methods"), "methods", false)?;
    for (files, ext, name) in [(&scripts, ".js", "renderer"), (&styles, ".css", "styles")] {
        ensure!(files.len() <= MAX_FILES, "claudeDesktop.{name} 最多 {MAX_FILES} 个文件");
        if let Some(bad) = files.iter().find(|file| !valid_file(file, ext)) {
            bail!("claudeDesktop.{name} 里的「{bad}」不合法：要用相对路径、以 {ext} 结尾，不能有隐藏文件或 ..");
        }
        let mut seen = std::collections::BTreeSet::new();
        if let Some(repeated) = files.iter().find(|file| !seen.insert(file.as_str())) {
            bail!("claudeDesktop.{name} 里「{repeated}」写了两次");
        }
    }
    ensure!(!scripts.is_empty() || !styles.is_empty(), "claudeDesktop 的页面部分至少要有一个 renderer 脚本或 styles 样式");
    ensure!(methods.len() <= MAX_METHODS, "claudeDesktop.methods 最多 {MAX_METHODS} 个");
    if let Some(bad) = methods.iter().find(|method| !valid_method(method)) {
        bail!("claudeDesktop.methods 里的后台方法名无效或属于内部方法：{bad}");
    }
    ensure!(methods.is_empty() || !scripts.is_empty(), "claudeDesktop.methods 是给页面脚本调后台用的，需要同时声明 renderer");
    Ok(Some(ClaudePage { scripts, styles, methods }))
}

/// `codexpp.json` 里 ClaudeMom 用得上的部分。
#[derive(Debug, Clone, Default)]
pub struct CodexppManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: String,
    pub description: String,
    pub routes: Vec<String>,
    /// 没有页面部分的包在 ClaudeMom 里没有可运行的内容。
    pub page: Option<ClaudePage>,
    /// 后台脚本（包内相对路径）。
    pub backend: Option<String>,
    /// 声明了 Code 会话里的按钮、事件或工具（走 Claude Code Mods，只在 Codex++ 里接了）。
    pub mods: bool,
    pub config_schema: Vec<ExtensionConfigField>,
    /// 出现了哪些只在 Codex++ 里生效的顶层字段。
    pub codex_only: Vec<String>,
}

fn text(raw: &Map<String, Value>, key: &str) -> Result<String> {
    match raw.get(key) {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::String(value)) => Ok(value.clone()),
        Some(_) => bail!("{key} 必须是字符串"),
    }
}

/// 解析并校验 `codexpp.json`；`expected_id` 给了时 id 必须与之相同（文件夹名）。
///
/// id 沿用页面扩展的规则（小写字母、数字、`-`）：它同时是文件夹名和页面地址的一段。
pub fn parse_codexpp_manifest(raw: &[u8], expected_id: Option<&str>) -> Result<CodexppManifest> {
    let Value::Object(raw) = serde_json::from_slice::<Value>(raw).context("codexpp.json 不是合法的 JSON")? else {
        bail!("codexpp.json 顶层必须是对象");
    };
    let id = text(&raw, "id")?;
    ensure!(
        valid_id(&id),
        "id「{id}」不能在这里用：只能是小写字母、数字和 -，最长 64 个字符（Codex++ 里允许的大写和 _ 这里不行）"
    );
    if let Some(expected) = expected_id {
        ensure!(id == expected, "清单里的 id「{id}」和文件夹名「{expected}」不一致");
    }
    let name = match text(&raw, "name")? {
        name if name.trim().is_empty() => id.clone(),
        name => name,
    };
    ensure!(within(&name, 64), "name 最长 64 个字符");
    let version = text(&raw, "version")?;
    ensure!(within(&version, 64), "version 最长 64 个字符");
    let author = text(&raw, "author")?;
    ensure!(within(&author, 64), "author 最长 64 个字符");
    let description = text(&raw, "description")?;
    ensure!(within(&description, 2000), "description 最长 2000 个字符");

    // engines.codexpp：整数是页面接口版本；字符串是对 Codex++ 版本的范围，这里没有 Codex++，不检查。
    match raw.get("engines").and_then(|engines| engines.get("codexpp")) {
        None | Some(Value::Null) | Some(Value::String(_)) => {}
        Some(engine) => {
            let engine = engine.as_u64().context("engines.codexpp 必须是正整数（接口版本）或版本范围字符串")?;
            ensure!(
                engine <= PAGE_API_VERSION,
                "这个拓展需要接口版本 {engine}，当前程序只支持到 {PAGE_API_VERSION}，请先更新程序"
            );
        }
    }
    let routes = match raw.get("permissions").and_then(|value| value.get("routes")) {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| item.as_str().map(str::to_owned))
            .collect::<Option<Vec<_>>>()
            .context("permissions.routes 只能是字符串数组")?,
        Some(_) => bail!("permissions.routes 只能是字符串数组"),
    };
    let backend = match raw.get("backend") {
        None | Some(Value::Null) => None,
        Some(Value::Object(backend)) => {
            let script = backend.get("script").and_then(Value::as_str).context("backend 缺少 script")?;
            ensure!(valid_file(script, ""), "backend.script「{script}」不合法：要用包内的相对路径，不能有隐藏文件或 ..");
            Some(script.to_string())
        }
        Some(_) => bail!("backend 必须是对象：{{ \"script\": \"backend/main.mjs\" }}"),
    };
    let (page, mods) = match raw.get("claudeDesktop") {
        None | Some(Value::Null) => (None, false),
        Some(block) => {
            let page = parse_claude_page(block)?;
            let declared = |name: &str| match block.get(name) {
                Some(Value::Array(items)) => !items.is_empty(),
                Some(Value::Object(items)) => !items.is_empty(),
                _ => false,
            };
            (page, ["buttons", "events", "tools"].into_iter().any(declared))
        }
    };
    if let Some(page) = &page {
        ensure!(page.methods.is_empty() || backend.is_some(), "claudeDesktop.methods 调用的是后台方法，需要同时声明 backend.script");
    }
    let config_schema = parse_extension_config_schema(raw.get("config"))?;
    let codex_only = CODEX_ONLY_FIELDS
        .iter()
        .filter(|name| raw.get(**name).is_some_and(|value| !value.is_null()))
        .map(|name| name.to_string())
        .collect();
    Ok(CodexppManifest { id, name, version, author, description, routes, page, backend, mods, config_schema, codex_only })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 共用用例：每条都要得到写明的结果。Codex++ 那边的集成测试跑的是同一份。
    #[test]
    fn shared_cases_parse_as_written() {
        let cases: Vec<Value> = serde_json::from_str(CODEXPP_CASES).unwrap();
        assert!(cases.len() >= 12);
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let parsed = parse_claude_page(&case["claudeDesktop"]);
            match &case["page"] {
                Value::Null => assert!(parsed.is_err(), "{name} 应当报错"),
                Value::Bool(false) => assert_eq!(parsed.unwrap(), None, "{name} 没有页面部分"),
                expected => {
                    let page = parsed.unwrap_or_else(|error| panic!("{name}: {error:#}")).unwrap_or_else(|| panic!("{name} 应当有页面部分"));
                    assert_eq!(&serde_json::to_value(&page).unwrap(), expected, "{name}");
                }
            }
        }
    }

    #[test]
    fn page_methods_follow_the_declared_list() {
        let page = parse_claude_page(&json!({ "renderer": "main.js", "methods": ["status", "a.b"] })).unwrap().unwrap();
        assert!(page.permits("status") && page.permits("a.b"));
        assert!(!page.permits("other") && !page.permits("__proto__") && !page.permits("constructor"));
    }

    fn manifest(extra: Value) -> Vec<u8> {
        let mut base = json!({ "id": "demo", "name": "Demo", "version": "1.0.0", "claudeDesktop": { "renderer": "main.js" } });
        base.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        base.to_string().into_bytes()
    }

    #[test]
    fn manifests_keep_what_claude_uses_and_note_the_rest() {
        let parsed = parse_codexpp_manifest(
            &manifest(json!({
                "renderer": "codex.js",
                "hooks": { "session-start": [] },
                "gateway": null,
                "engines": { "codexpp": "^2.1" },
                "permissions": { "routes": ["/backend/status"] },
                "backend": { "script": "backend/main.mjs" },
                "config": { "minutes": { "type": "number", "default": 5 } },
                "claudeDesktop": { "renderer": ["a.js", "b.js"], "styles": ["a.css"], "methods": ["status"], "buttons": [{ "id": "x", "label": "X", "method": "status" }] },
            })),
            Some("demo"),
        )
        .unwrap();
        assert_eq!(parsed.codex_only, ["renderer", "hooks"]);
        assert_eq!(parsed.routes, ["/backend/status"]);
        assert_eq!(parsed.backend.as_deref(), Some("backend/main.mjs"));
        assert!(parsed.mods);
        assert_eq!(parsed.page.unwrap().scripts, ["a.js", "b.js"]);
        assert_eq!(parsed.config_schema.len(), 1);

        let bare = parse_codexpp_manifest(br#"{ "id": "bare" }"#, None).unwrap();
        assert_eq!((bare.name.as_str(), bare.version.as_str(), bare.page.is_none()), ("bare", "", true));
    }

    #[test]
    fn manifests_are_rejected_for_what_cannot_work_here() {
        for (label, extra) in [
            ("大写 id", json!({ "id": "Demo" })),
            ("下划线 id", json!({ "id": "de_mo" })),
            ("接口版本太新", json!({ "engines": { "codexpp": PAGE_API_VERSION + 1 } })),
            ("方法没有后台", json!({ "claudeDesktop": { "renderer": "main.js", "methods": ["status"] } })),
            ("后台路径出包", json!({ "backend": { "script": "../x.mjs" } })),
            ("配置写错", json!({ "config": { "x": { "type": "date" } } })),
            ("路由不是数组", json!({ "permissions": { "routes": "/a" } })),
        ] {
            assert!(parse_codexpp_manifest(&manifest(extra), None).is_err(), "{label}");
        }
        assert!(parse_codexpp_manifest(&manifest(json!({})), Some("other")).is_err(), "和文件夹名不一致");
        assert!(parse_codexpp_manifest(&manifest(json!({ "engines": { "codexpp": PAGE_API_VERSION } })), None).is_ok());
    }
}
