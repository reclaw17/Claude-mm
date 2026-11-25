//! 注入计划：把「启用中的 Claude 页面拓展」渲染成一份可以直接执行的清单。
//!
//! 页面运行时（`runtime/page-runtime.js`）、每个包的包装（`runtime/page-wrap.js`）和清单规则都只在这里
//! 用一次。两处注入方只做「读文件、拼接、执行」，不认识清单也不认识包装：
//!
//! - 完整功能模式：本地服务读 `<状态目录>/claude-local/page-plan.json`（[`refresh_page_plan`] 写），
//!   把运行时和每个包各作为一个同源脚本插进页面。
//! - 补丁副本：宿主把 [`page_plan`]`(Binding)` 写给主进程 hook，hook 逐段执行。
//!
//! 一段脚本由若干片拼成：`{ text }` 原样拼上，`{ file }` 读包里的文件拼上（`json` 为真时先
//! `JSON.stringify`，样式文本就是这样变成一个字符串字面量的）。脚本文件是执行时现读的，所以改了
//! 脚本刷新页面就生效；改了清单、开关或配置要重新生成计划（列表刷新、开关、保存配置时都会重新生成）。

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::Serialize;
use serde_json::{Value, json};

use super::codexpp::PAGE_API_VERSION;
use super::config::{ExtensionConfigField, resolve_extension_config, strip_secret_config};
use super::{Package, USER_DIR};

const WRAP_TEMPLATE: &str = include_str!("../../runtime/page-wrap.js");
const LEGACY_TEMPLATE: &str = include_str!("../../runtime/page-legacy-wrap.js");
const RUNTIME_SOURCE: &str = include_str!("../../runtime/page-runtime.js");
const ANCHORS_SOURCE: &str = include_str!("../../runtime/page-anchors.js");

/// 页面接口的契约清单（成员名、常量键）：claude-local 的运行时测试和 Codex++ 的契约测试都对着它。
pub const PAGE_API_CONTRACT: &str = include_str!("../../runtime/page-api.json");

pub const PLAN_FILE: &str = "page-plan.json";
pub const PLAN_VERSION: u32 = 1;
/// 完整功能模式下页面调本地服务要带的令牌；计划里是占位符，本地服务下发运行时时换成本次启动的随机值。
pub const PAGE_TOKEN_PLACEHOLDER: &str = "__CODEXPP_PAGE_TOKEN__";
pub const PAGE_API_PREFIX: &str = "/__codex_plus/api/v1/";
/// 补丁副本里页面调主进程的 binding 名，和主进程把结果投回页面时调的函数名。
pub const PAGE_BINDING: &str = "__codexPlusClaudeCall";
pub const PAGE_DELIVER: &str = "__codexPlusClaudeDeliver";

/// 页面怎么调到后台。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PageTransport {
    /// 完整功能模式：页面与本地服务同源，走 `POST /__codex_plus/api/v1/<op>`。
    Http,
    /// 补丁副本：主进程 hook 注册的 CDP binding。
    Binding,
}

/// 宿主（Codex++）自己目录里启用中的 Claude 页面包。开关、配置都归宿主管，这里只负责注入。
#[derive(Debug, Clone, Default)]
pub struct HostPagePackage {
    /// 宿主那边的脚本 key（Codex++ 是 `user:<目录名>`），页面上的状态记录、节点归属标记都用它。
    pub key: String,
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    /// 包目录（绝对路径）。
    pub root: PathBuf,
    pub scripts: Vec<String>,
    pub styles: Vec<String>,
    pub methods: Vec<String>,
    pub routes: Vec<String>,
    /// 后台脚本（绝对路径）。
    pub backend: Option<PathBuf>,
    /// 生效配置（含密钥）。交给页面前会按 `config_schema` 去掉密钥。
    pub config: Value,
    pub config_schema: Vec<ExtensionConfigField>,
    /// 后台的数据目录。
    pub data_dir: PathBuf,
}

/// 一片脚本内容。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum PagePiece {
    Text {
        text: String,
    },
    File {
        /// 相对所在段的 `root`。
        file: String,
        /// 读出来后先 `JSON.stringify` 再拼。
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        json: bool,
    },
}

/// 一段可以单独执行的脚本。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSegment {
    pub key: String,
    /// `File` 片所在的目录；读文件时不能出这个目录、不跟符号链接。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<PathBuf>,
    pub pieces: Vec<PagePiece>,
}

/// 一个 `codexpp.json` 包：页面上要执行的那一段，加上服务端校验页面调用要用的声明。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PagePackage {
    pub key: String,
    /// 地址里用的名字（`/__codex_plus/pkg/<slug>.js`）。
    pub slug: String,
    pub id: String,
    pub name: String,
    pub version: String,
    pub root: PathBuf,
    pub pieces: Vec<PagePiece>,
    /// 页面可以调的后台方法、可以调的路由。
    pub methods: Vec<String>,
    pub routes: Vec<String>,
    pub backend: Option<PathBuf>,
    /// 给后台的生效配置（含密钥）；不下发页面。
    pub config: Value,
    pub data_dir: PathBuf,
    /// 来自宿主的包：后台由宿主托管。
    pub hosted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageBinding {
    pub name: String,
    pub deliver: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PagePlan {
    pub version: u32,
    pub transport: PageTransport,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binding: Option<PageBinding>,
    /// 页面运行时；没有 `codexpp.json` 包启用时为 `None`，页面上什么都不加。
    pub runtime: Option<PageSegment>,
    /// 旧格式（`manifest.json`）页面扩展，一个文件一段，要在页面脚本之前执行。
    /// 只在 [`PageTransport::Binding`] 下有：完整功能模式里它们由本地服务按原来的方式插进页面。
    pub legacy: Vec<PageSegment>,
    pub packages: Vec<PagePackage>,
}

fn push_text(pieces: &mut Vec<PagePiece>, text: &str) {
    if text.is_empty() {
        return;
    }
    match pieces.last_mut() {
        Some(PagePiece::Text { text: last }) => last.push_str(text),
        _ => pieces.push(PagePiece::Text { text: text.to_string() }),
    }
}

/// 按模板把一个包渲染成若干片：样式先于脚本，脚本按清单顺序拼在同一个作用域里。
fn render_package(meta: &Value, scripts: &[String], styles: &[String]) -> Vec<PagePiece> {
    let (head, rest) = WRAP_TEMPLATE.split_once("/*CODEXPP_STYLES*/").expect("page-wrap.js 缺少样式标记");
    let (middle, tail) = rest.split_once("/*CODEXPP_SOURCE*/").expect("page-wrap.js 缺少脚本标记");
    let mut pieces = Vec::new();
    push_text(&mut pieces, &head.replacen("/*CODEXPP_META*/null", &meta.to_string(), 1));
    for file in styles {
        push_text(&mut pieces, &format!("    runtime.addStyle(meta.key, {}, ", json!(file)));
        pieces.push(PagePiece::File { file: file.clone(), json: true });
        push_text(&mut pieces, ");\n");
    }
    push_text(&mut pieces, middle);
    for file in scripts {
        pieces.push(PagePiece::File { file: file.clone(), json: false });
        push_text(&mut pieces, "\n;\n");
    }
    push_text(&mut pieces, tail);
    pieces
}

/// 旧格式扩展的一个文件。`body` 给了就直接拼进去（内置扩展随程序打包，不依赖磁盘上装没装）。
fn render_legacy(tag: &str, file: &str, style: bool, body: Option<&str>) -> Vec<PagePiece> {
    let (head, tail) = LEGACY_TEMPLATE.split_once("/*CODEXPP_BODY*/").expect("page-legacy-wrap.js 缺少正文标记");
    let mut pieces = Vec::new();
    push_text(&mut pieces, &head.replacen("/*CODEXPP_TAG*/\"\"", &json!(tag).to_string(), 1));
    let content = |pieces: &mut Vec<PagePiece>, json: bool| match body {
        Some(body) if json => push_text(pieces, &json!(body).to_string()),
        Some(body) => push_text(pieces, body),
        None => pieces.push(PagePiece::File { file: file.to_string(), json }),
    };
    if style {
        push_text(
            &mut pieces,
            "      const node = document.createElement(\"style\"); node.setAttribute(\"data-codex-plus-page-ext\", tag); node.textContent = ",
        );
        content(&mut pieces, true);
        push_text(&mut pieces, "; document.head.appendChild(node);");
    } else {
        push_text(&mut pieces, "      (function () {\n");
        content(&mut pieces, false);
        push_text(&mut pieces, "\n      }).call(window);");
    }
    push_text(&mut pieces, tail);
    pieces
}

/// 交给页面的清单与状态记录（`window.__codexPlusUserScripts.scripts[key]`）。密钥配置不在里面。
#[allow(clippy::too_many_arguments)]
fn page_meta(
    key: &str,
    id: &str,
    name: &str,
    version: &str,
    description: &str,
    routes: &[String],
    methods: &[String],
    backend: bool,
    config: &Value,
    schema: &[ExtensionConfigField],
    source: &str,
) -> Value {
    json!({
        "key": key,
        "name": name,
        "source": source,
        "manifest": {
            "id": id,
            "name": name,
            "version": version,
            "description": description,
            "engines": { "codexpp": PAGE_API_VERSION },
            "permissions": { "routes": routes },
            "config": strip_secret_config(schema, config),
            "claudeDesktop": { "methods": methods, "backend": backend },
        },
    })
}

fn slug(prefix: &str, id: &str) -> String {
    let safe: String = id.chars().map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' { ch } else { '-' }).collect();
    format!("{prefix}-{safe}")
}

fn host_package(package: &HostPagePackage) -> PagePackage {
    let meta = page_meta(
        &package.key,
        &package.id,
        &package.name,
        &package.version,
        &package.description,
        &package.routes,
        &package.methods,
        package.backend.is_some(),
        &package.config,
        &package.config_schema,
        "host",
    );
    PagePackage {
        key: package.key.clone(),
        slug: slug("h", &package.id),
        id: package.id.clone(),
        name: package.name.clone(),
        version: package.version.clone(),
        root: package.root.clone(),
        pieces: render_package(&meta, &package.scripts, &package.styles),
        methods: package.methods.clone(),
        routes: package.routes.clone(),
        backend: package.backend.clone(),
        config: package.config.clone(),
        data_dir: package.data_dir.clone(),
        hosted: true,
    }
}

/// 本地目录里启用中的 `codexpp.json` 包；和宿主包同 id 的让给宿主。
fn local_packages(root: &Path, taken: &BTreeSet<&str>) -> Vec<PagePackage> {
    let configs = super::read_configs(root);
    let mut packages = Vec::new();
    for id in super::read_enabled(root) {
        if taken.contains(id.as_str()) {
            continue;
        }
        let dir = root.join(USER_DIR).join(&id);
        let Ok(Package::Codexpp(manifest)) = super::load_user_package(&dir, &id) else {
            continue;
        };
        let Some(page) = &manifest.page else {
            continue;
        };
        let config = resolve_extension_config(&manifest.config_schema, configs.get(&id));
        let key = format!("local:{id}");
        let meta = page_meta(
            &key,
            &id,
            &manifest.name,
            &manifest.version,
            &manifest.description,
            &manifest.routes,
            &page.methods,
            manifest.backend.is_some(),
            &config,
            &manifest.config_schema,
            "local",
        );
        packages.push(PagePackage {
            key,
            slug: slug("l", &id),
            name: manifest.name.clone(),
            version: manifest.version.clone(),
            pieces: render_package(&meta, &page.scripts, &page.styles),
            methods: page.methods.clone(),
            routes: manifest.routes.clone(),
            backend: manifest.backend.as_ref().map(|script| dir.join(script)),
            config,
            data_dir: root.join("extension-data").join(&id),
            root: dir,
            id,
            hosted: false,
        });
    }
    packages
}

/// 启用中的旧格式扩展，顺序同 [`super::enabled_assets`]：按 id，每个扩展先样式后脚本。
fn legacy_segments(root: &Path) -> Vec<PageSegment> {
    let builtin = super::builtin_manifests();
    let mut segments = Vec::new();
    for id in super::read_enabled(root) {
        let dir = root.join(USER_DIR).join(&id);
        let shipped = builtin.iter().find(|manifest| manifest.id == id);
        let manifest = match shipped {
            Some(manifest) => manifest.clone(),
            None => match super::load_user_package(&dir, &id) {
                Ok(Package::Legacy(manifest)) => manifest,
                _ => continue,
            },
        };
        let files = manifest.styles.iter().map(|file| (file, true)).chain(manifest.scripts.iter().map(|file| (file, false)));
        for (file, style) in files {
            let tag = format!("{id}/{file}");
            let body = shipped.and_then(|_| super::builtin_file(&id, file)).and_then(|body| String::from_utf8(body).ok());
            if shipped.is_some() && body.is_none() {
                continue;
            }
            segments.push(PageSegment {
                pieces: render_legacy(&tag, file, style, body.as_deref()),
                root: if shipped.is_some() { None } else { Some(dir.clone()) },
                key: tag,
            });
        }
    }
    segments
}

fn runtime_segment(transport: PageTransport, binding: Option<&PageBinding>, packages: &[PagePackage]) -> PageSegment {
    let mut boot = json!({
        "version": PLAN_VERSION,
        "apiVersion": PAGE_API_VERSION,
        "host": "claudeDesktop",
        "transport": transport,
        "packages": packages
            .iter()
            .map(|package| json!({ "key": package.key, "name": package.name, "slug": package.slug }))
            .collect::<Vec<_>>(),
    });
    match transport {
        PageTransport::Http => {
            boot["token"] = json!(PAGE_TOKEN_PLACEHOLDER);
            boot["api"] = json!(PAGE_API_PREFIX);
        }
        PageTransport::Binding => boot["binding"] = json!(binding),
    }
    PageSegment {
        key: "runtime".to_string(),
        root: None,
        pieces: vec![PagePiece::Text {
            text: format!("window.__codexPlusClaudeBoot = {boot};\n{ANCHORS_SOURCE}\n;\n{RUNTIME_SOURCE}"),
        }],
    }
}

/// 启用中的包：本地目录里的在前，宿主的在后；同 id 以宿主的为准。
fn packages_in(root: &Path, host: &[HostPagePackage]) -> Vec<PagePackage> {
    let taken: BTreeSet<&str> = host.iter().map(|package| package.id.as_str()).collect();
    let mut packages = local_packages(root, &taken);
    packages.extend(host.iter().map(host_package));
    packages
}

/// 按 key 取一个启用中的包。宿主自己托管拓展后台时，用它校验页面的调用（方法、路由是不是声明过）、
/// 拿后台脚本、配置和数据目录。每次现查：拓展被停用后立刻取不到。
pub fn page_package(key: &str) -> Option<PagePackage> {
    packages_in(&crate::backend::root_dir(), &crate::host::page_packages()).into_iter().find(|package| package.key == key)
}

/// 启用中的包的 key。
pub fn page_package_keys() -> BTreeSet<String> {
    packages_in(&crate::backend::root_dir(), &crate::host::page_packages()).into_iter().map(|package| package.key).collect()
}

/// 生成计划。纯函数：`root` 是 `<状态目录>/claude-local`，`host` 是宿主交来的包。
pub fn page_plan_in(root: &Path, host: &[HostPagePackage], transport: PageTransport) -> PagePlan {
    let packages = packages_in(root, host);
    let binding = (transport == PageTransport::Binding)
        .then(|| PageBinding { name: PAGE_BINDING.to_string(), deliver: PAGE_DELIVER.to_string() });
    PagePlan {
        version: PLAN_VERSION,
        transport,
        runtime: (!packages.is_empty()).then(|| runtime_segment(transport, binding.as_ref(), &packages)),
        legacy: if transport == PageTransport::Binding { legacy_segments(root) } else { Vec::new() },
        binding,
        packages,
    }
}

/// 当前要注入页面的内容。
pub fn page_plan(transport: PageTransport) -> PagePlan {
    page_plan_in(&crate::backend::root_dir(), &crate::host::page_packages(), transport)
}

/// 把完整功能模式的计划写到 `<root>/page-plan.json`（内容没变不写）。计划里有给后台的配置（可能含密钥），
/// 文件只有本人可读。
pub(crate) fn refresh_page_plan_in(root: &Path, host: &[HostPagePackage]) -> Result<bool> {
    let body = serde_json::to_vec(&page_plan_in(root, host, PageTransport::Http))?;
    let path = root.join(PLAN_FILE);
    if fs::read(&path).is_ok_and(|existing| existing == body) {
        return Ok(false);
    }
    crate::private_dir(root)?;
    crate::fsutil::atomic_write(&path, &body)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(true)
}

/// 重新生成完整功能模式的计划。开关、配置、装卸之后调用；宿主自己目录里的包变了也要调。
/// 写不了只记诊断：计划在列表刷新和启动本地服务时还会再生成。
pub fn refresh_page_plan() {
    if let Err(error) = refresh_page_plan_in(&crate::backend::root_dir(), &crate::host::page_packages()) {
        crate::host::diagnostic("claude_local.page_plan_failed", json!({ "error": format!("{error:#}") }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_of(pieces: &[PagePiece], read: impl Fn(&str) -> String) -> String {
        pieces
            .iter()
            .map(|piece| match piece {
                PagePiece::Text { text } => text.clone(),
                PagePiece::File { file, json: true } => json!(read(file)).to_string(),
                PagePiece::File { file, json: false } => read(file),
            })
            .collect()
    }

    fn write_codexpp(root: &Path, id: &str, manifest: Value) -> PathBuf {
        let dir = root.join(USER_DIR).join(id);
        fs::create_dir_all(&dir).unwrap();
        let mut base = json!({ "id": id, "name": id, "version": "1.0.0" });
        base.as_object_mut().unwrap().extend(manifest.as_object().unwrap().clone());
        fs::write(dir.join("codexpp.json"), base.to_string()).unwrap();
        dir
    }

    #[test]
    fn templates_carry_each_marker_exactly_once() {
        for marker in ["/*CODEXPP_META*/null", "/*CODEXPP_STYLES*/", "/*CODEXPP_SOURCE*/"] {
            assert_eq!(WRAP_TEMPLATE.matches(marker).count(), 1, "{marker}");
        }
        for marker in ["/*CODEXPP_TAG*/\"\"", "/*CODEXPP_BODY*/"] {
            assert_eq!(LEGACY_TEMPLATE.matches(marker).count(), 1, "{marker}");
        }
    }

    #[test]
    fn nothing_is_added_to_the_page_until_a_codexpp_package_is_enabled() {
        let root = tempfile::tempdir().unwrap();
        write_codexpp(root.path(), "demo", json!({ "claudeDesktop": { "renderer": "main.js" } }));
        let plan = page_plan_in(root.path(), &[], PageTransport::Http);
        assert!(plan.runtime.is_none() && plan.packages.is_empty() && plan.legacy.is_empty());
        assert!(refresh_page_plan_in(root.path(), &[]).unwrap());
        assert!(!refresh_page_plan_in(root.path(), &[]).unwrap(), "内容没变不重写");
    }

    #[test]
    fn a_package_renders_styles_first_then_scripts_in_one_scope() {
        let root = tempfile::tempdir().unwrap();
        write_codexpp(
            root.path(),
            "demo",
            json!({
                "description": "D",
                "permissions": { "routes": ["/backend/status"] },
                "backend": { "script": "backend.mjs" },
                "config": { "minutes": { "type": "number", "default": 5 }, "token": { "type": "string", "secret": true } },
                "claudeDesktop": { "renderer": ["a.js", "b.js"], "styles": ["a.css"], "methods": ["status"] },
            }),
        );
        super::super::write_enabled(root.path(), &["demo".to_string()].into()).unwrap();
        super::super::write_configs(root.path(), &[("demo".to_string(), json!({ "token": "sk-1" }).as_object().unwrap().clone())].into())
            .unwrap();

        let plan = page_plan_in(root.path(), &[], PageTransport::Http);
        let package = &plan.packages[0];
        assert_eq!((package.key.as_str(), package.slug.as_str(), package.hosted), ("local:demo", "l-demo", false));
        assert_eq!(package.methods, ["status"]);
        assert_eq!(package.config, json!({ "minutes": 5, "token": "sk-1" }), "后台拿完整配置");
        assert_eq!(package.backend.as_deref(), Some(root.path().join("extensions/demo/backend.mjs").as_path()));
        assert_eq!(package.data_dir, root.path().join("extension-data/demo"));

        let script = text_of(&package.pieces, |file| match file {
            "a.css" => "body{}".to_string(),
            other => format!("window.ran = (window.ran || '') + '{other};';"),
        });
        assert!(!script.contains("sk-1"), "密钥不进页面");
        assert!(script.contains(r#""config":{"minutes":5,"token":null}"#), "{script}");
        assert!(script.contains(r#"runtime.addStyle(meta.key, "a.css", "body{}");"#), "{script}");
        let (style_at, a_at, b_at, end_at) =
            (script.find("addStyle").unwrap(), script.find("'a.js;'").unwrap(), script.find("'b.js;'").unwrap(), script.find("runtime.endPackage(meta.key);").unwrap());
        assert!(style_at < a_at && a_at < b_at && b_at < end_at);

        let runtime = text_of(&plan.runtime.as_ref().unwrap().pieces, |_| unreachable!());
        assert!(runtime.starts_with("window.__codexPlusClaudeBoot = {"));
        assert!(runtime.contains(PAGE_TOKEN_PLACEHOLDER) && runtime.contains(r#""packages":[{"key":"local:demo","name":"demo","slug":"l-demo"}]"#));
        assert!(plan.binding.is_none());
    }

    #[test]
    fn host_packages_join_the_plan_and_win_over_a_local_package_with_the_same_id() {
        let root = tempfile::tempdir().unwrap();
        write_codexpp(root.path(), "demo", json!({ "claudeDesktop": { "renderer": "local.js" } }));
        write_codexpp(root.path(), "other", json!({ "claudeDesktop": { "styles": ["a.css"] } }));
        super::super::write_enabled(root.path(), &["demo".to_string(), "other".to_string()].into()).unwrap();
        let host = HostPagePackage {
            key: "user:demo".into(),
            id: "demo".into(),
            name: "Demo".into(),
            root: PathBuf::from("/host/demo"),
            scripts: vec!["main.js".into()],
            methods: vec!["status".into()],
            backend: Some(PathBuf::from("/host/demo/backend.mjs")),
            config: json!({ "key": "secret" }),
            config_schema: super::super::config::parse_extension_config_schema(Some(&json!({ "key": { "type": "string", "secret": true } })))
                .unwrap(),
            data_dir: PathBuf::from("/host/data/demo"),
            ..Default::default()
        };
        let plan = page_plan_in(root.path(), &[host], PageTransport::Binding);
        let keys: Vec<_> = plan.packages.iter().map(|package| (package.key.as_str(), package.hosted)).collect();
        assert_eq!(keys, [("local:other", false), ("user:demo", true)]);
        let hosted = &plan.packages[1];
        assert_eq!((hosted.slug.as_str(), hosted.root.as_path()), ("h-demo", Path::new("/host/demo")));
        assert!(!text_of(&hosted.pieces, |_| String::new()).contains("secret"));
        let binding = plan.binding.as_ref().unwrap();
        assert_eq!((binding.name.as_str(), binding.deliver.as_str()), (PAGE_BINDING, PAGE_DELIVER));
        let runtime = text_of(&plan.runtime.as_ref().unwrap().pieces, |_| unreachable!());
        assert!(runtime.contains(r#""transport":"binding""#) && !runtime.contains(PAGE_TOKEN_PLACEHOLDER));
    }

    #[test]
    fn legacy_extensions_ride_along_only_for_the_patched_copy() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join(USER_DIR).join("theme");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("manifest.json"),
            json!({ "id": "theme", "name": "Theme", "version": "1.0.0", "scripts": ["main.js"], "styles": ["a.css"] }).to_string(),
        )
        .unwrap();
        super::super::write_enabled(root.path(), &["theme".to_string(), "wide-chat".to_string()].into()).unwrap();

        assert!(page_plan_in(root.path(), &[], PageTransport::Http).legacy.is_empty());
        let plan = page_plan_in(root.path(), &[], PageTransport::Binding);
        assert!(plan.runtime.is_none(), "只有旧格式扩展时不注入运行时");
        let keys: Vec<_> = plan.legacy.iter().map(|segment| (segment.key.as_str(), segment.root.is_some())).collect();
        assert_eq!(keys, [("theme/a.css", true), ("theme/main.js", true), ("wide-chat/wide-chat.js", false)]);
        let style = text_of(&plan.legacy[0].pieces, |_| "body{}".to_string());
        assert!(style.contains(r#"const tag = "theme/a.css";"#) && style.contains(r#"node.textContent = "body{}";"#), "{style}");
        let builtin = text_of(&plan.legacy[2].pieces, |_| unreachable!("内置扩展的内容直接在计划里"));
        assert!(builtin.contains("transcript-width"));
    }

    /// 本地服务的 Node 测试（managed.test.mjs）用的计划样本就是这里生成的，两边对同一份形状。
    /// 模板或计划形状改了之后用 `CLAUDE_LOCAL_UPDATE_FIXTURES=1 cargo test -p claude-local plan` 重新生成。
    #[cfg(unix)]
    #[test]
    fn the_plan_matches_the_fixture_the_node_tests_use() {
        let root = tempfile::tempdir().unwrap();
        write_codexpp(
            root.path(),
            "demo",
            json!({
                "name": "Demo",
                "description": "Fixture",
                "permissions": { "routes": ["/backend/status", "/usage/history"] },
                "backend": { "script": "backend.mjs" },
                "config": { "minutes": { "type": "number", "default": 5 }, "token": { "type": "string", "secret": true } },
                "claudeDesktop": { "renderer": ["main.js"], "styles": ["css/a.css"], "methods": ["status", "config", "fail", "tick"] },
            }),
        );
        super::super::write_enabled(root.path(), &["demo".to_string()].into()).unwrap();
        super::super::write_configs(root.path(), &[("demo".to_string(), json!({ "token": "sk-fixture" }).as_object().unwrap().clone())].into())
            .unwrap();
        let mut plan = serde_json::to_value(page_plan_in(root.path(), &[], PageTransport::Http)).unwrap();
        let runtime = plan["runtime"]["pieces"][0]["text"].as_str().unwrap().to_string();
        let boot = runtime.split_once('\n').unwrap().0;
        plan["runtime"]["pieces"][0]["text"] = json!(format!("{boot}\n<RUNTIME>"));
        let rendered = serde_json::to_string_pretty(&plan).unwrap().replace(&*root.path().to_string_lossy(), "<ROOT>") + "\n";
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("runtime/fixtures/page-plan.json");
        if std::env::var_os("CLAUDE_LOCAL_UPDATE_FIXTURES").is_some() {
            fs::write(&fixture, &rendered).unwrap();
        }
        assert_eq!(
            fs::read_to_string(&fixture).unwrap_or_default(),
            rendered,
            "计划的形状变了：用 CLAUDE_LOCAL_UPDATE_FIXTURES=1 重新生成 runtime/fixtures/page-plan.json，并确认 Node 测试仍然通过"
        );
    }

    #[test]
    fn the_contract_file_is_valid_json() {
        let contract: Value = serde_json::from_str(PAGE_API_CONTRACT).unwrap();
        for group in ["api", "ctx", "constants"] {
            assert!(contract[group].as_array().is_some_and(|items| !items.is_empty()), "{group}");
        }
    }
}
