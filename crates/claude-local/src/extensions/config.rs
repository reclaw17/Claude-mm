//! 拓展配置（`codexpp.json` 的 `config`）：字段声明、校验、默认值合并、密钥打码。
//!
//! ClaudeMom 与 Codex++ 共用这一份规则：Codex++ 的 `user_scripts` 直接引用这里的类型和函数。

use anyhow::Context;
use serde_json::{Map, Value, json};

/// 拓展配置项（codexpp.json 的 `config.<key>`）。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionConfigField {
    pub key: String,
    /// string / text（多行）/ number / boolean / select / array / object
    #[serde(rename = "type")]
    pub kind: String,
    /// 字符串，或 `{ en, zh, ... }` 多语言文本（管理器按界面语言显示）。
    pub title: Value,
    pub description: Value,
    pub default: Value,
    /// select 的可选值：[{ value, label }]
    pub options: Vec<Value>,
    /// 界面上按密码框显示。值仍以明文存在本机 user_scripts.json。
    pub secret: bool,
    /// number 的取值范围。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    /// array 的元素类型（键为空的字段）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<Box<ExtensionConfigField>>,
    /// object 的子字段。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub properties: Vec<ExtensionConfigField>,
    /// string 的输入方式：`file` 表示本机文件路径，管理器显示「选择…」按钮。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    /// `format: "file"` 时选择器只列这些扩展名（不带点）；空表示不限。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub extensions: Vec<String>,
}

impl ExtensionConfigField {
    /// 校验一个值是否合乎类型；select 必须是可选值之一；对象可以缺键（缺的取默认），不能有未声明的键。
    pub fn accepts(&self, value: &Value) -> bool {
        match self.kind.as_str() {
            "string" | "text" => value.is_string(),
            "number" => value.as_f64().is_some_and(|number| {
                self.min.is_none_or(|min| number >= min) && self.max.is_none_or(|max| number <= max)
            }),
            "boolean" => value.is_boolean(),
            "select" => self.options.iter().any(|option| option.get("value") == Some(value)),
            "array" => value.as_array().is_some_and(|items| {
                items.len() <= 200 && self.items.as_ref().is_some_and(|field| items.iter().all(|item| field.accepts(item)))
            }),
            "object" => value.as_object().is_some_and(|map| {
                map.iter().all(|(key, item)| {
                    self.properties.iter().find(|field| &field.key == key).is_some_and(|field| field.accepts(item))
                })
            }),
            _ => false,
        }
    }

    /// 生效值：合法的已存值，对象逐个子字段合并默认值；否则取默认值。
    pub fn resolve(&self, stored: Option<&Value>) -> Value {
        match (self.kind.as_str(), stored) {
            ("object", Some(Value::Object(map))) if self.accepts(&Value::Object(map.clone())) => {
                Value::Object(self.properties.iter().map(|field| (field.key.clone(), field.resolve(map.get(&field.key)))).collect())
            }
            ("object", _) => self.default.clone(),
            (_, Some(value)) if self.accepts(value) => value.clone(),
            _ => self.default.clone(),
        }
    }
}


/// 交给模型前 secret 配置项显示成的打码值。
pub const SECRET_MASK: &str = "******";

/// 把配置里 secret 项（含对象子字段、数组元素里的）换成打码值。`schema` 是序列化后的字段数组，
/// 交给模型的清单、配置结果都要过一遍，免得 API Key 进模型上下文和会话记录。
pub fn mask_secret_config(schema: &Value, config: &Value) -> Value {
    fn mask_field(field: &Value, value: &Value) -> Value {
        if field["secret"].as_bool() == Some(true) {
            return match value {
                Value::Null => Value::Null,
                Value::String(text) if text.is_empty() => value.clone(),
                _ => Value::String(SECRET_MASK.into()),
            };
        }
        match (field["type"].as_str(), value) {
            (Some("object"), Value::Object(_)) => mask_secret_config(&field["properties"], value),
            (Some("array"), Value::Array(items)) => Value::Array(items.iter().map(|item| mask_field(&field["items"], item)).collect()),
            _ => value.clone(),
        }
    }
    let (Some(fields), Some(map)) = (schema.as_array(), config.as_object()) else {
        return config.clone();
    };
    Value::Object(
        map.iter()
            .map(|(key, value)| {
                let masked = fields.iter().find(|field| field["key"] == *key).map_or_else(|| value.clone(), |field| mask_field(field, value));
                (key.clone(), masked)
            })
            .collect(),
    )
}

/// 生效配置：每个声明的键取已存且合法的值，否则取默认值（对象按子字段合并）。
pub fn resolve_extension_config(schema: &[ExtensionConfigField], stored: Option<&Map<String, Value>>) -> Value {
    let mut resolved = Map::new();
    for field in schema {
        resolved.insert(field.key.clone(), field.resolve(stored.and_then(|values| values.get(&field.key))));
    }
    Value::Object(resolved)
}


/// 解析 `config`：`{ "minutes": { "type": "number", "title": "时长", "default": 25 } }`。
pub fn parse_extension_config_schema(value: Option<&Value>) -> anyhow::Result<Vec<ExtensionConfigField>> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let map = value.as_object().context("config 必须是对象：{ 键: { type, title, default } }")?;
    if map.len() > 32 {
        anyhow::bail!("config 最多 32 项");
    }
    map.iter().map(|(key, field)| parse_config_field(key, &format!("config.{key}"), field, 0)).collect()
}

/// 解析一个配置字段。`path` 用于报错（如 `config.proxy.host`），`depth` 限制对象嵌套层数。
fn parse_config_field(key: &str, path: &str, field: &Value, depth: usize) -> anyhow::Result<ExtensionConfigField> {
    if !key.is_empty() && !key.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-') {
        anyhow::bail!("配置键 {key:?} 只能包含字母、数字、_、-");
    }
    let field = field.as_object().with_context(|| format!("{path} 必须是对象"))?;
    let kind = field.get("type").and_then(Value::as_str).unwrap_or("string").to_string();
    if !["string", "text", "number", "boolean", "select", "array", "object"].contains(&kind.as_str()) {
        anyhow::bail!("{path}.type 只能是 string、text、number、boolean、select、array、object");
    }
    // title / description：字符串，或 { 语言: 文本 } 多语言对象。
    let text = |name: &str, fallback: &str| -> anyhow::Result<Value> {
        match field.get(name) {
            None => Ok(json!(fallback)),
            Some(Value::String(text)) => Ok(json!(text)),
            Some(Value::Object(map)) if !map.is_empty() && map.values().all(Value::is_string) => Ok(Value::Object(map.clone())),
            Some(_) => anyhow::bail!("{path}.{name} 必须是字符串或 {{ 语言: 文本 }}"),
        }
    };
    let options = match field.get("options") {
        None => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Object(object) if object.contains_key("value") => Ok(json!({
                    "value": object["value"],
                    "label": object.get("label").and_then(Value::as_str).map(str::to_owned)
                        .unwrap_or_else(|| object["value"].to_string().trim_matches('"').to_string()),
                })),
                Value::String(_) | Value::Number(_) | Value::Bool(_) => Ok(json!({ "value": item, "label": item.to_string().trim_matches('"') })),
                _ => anyhow::bail!("{path}.options 的每一项要么是值，要么是 {{ value, label }}"),
            })
            .collect::<anyhow::Result<Vec<_>>>()?,
        Some(_) => anyhow::bail!("{path}.options 必须是数组"),
    };
    if kind == "select" && options.is_empty() {
        anyhow::bail!("{path} 是 select，必须给 options");
    }
    let bound = |name: &str| -> anyhow::Result<Option<f64>> {
        match field.get(name) {
            None => Ok(None),
            Some(value) => value.as_f64().map(Some).with_context(|| format!("{path}.{name} 必须是数字")),
        }
    };
    let items = if kind == "array" {
        let items = field.get("items").with_context(|| format!("{path} 是 array，必须给 items（元素类型）"))?;
        let item = parse_config_field("", &format!("{path}.items"), items, depth + 1)?;
        if matches!(item.kind.as_str(), "array" | "object") {
            anyhow::bail!("{path}.items 只能是简单类型（string、text、number、boolean、select）");
        }
        Some(Box::new(item))
    } else {
        None
    };
    let properties = if kind == "object" {
        if depth >= 2 {
            anyhow::bail!("{path} 嵌套过深（对象最多 3 层）");
        }
        let map = field
            .get("properties")
            .and_then(Value::as_object)
            .filter(|map| !map.is_empty())
            .with_context(|| format!("{path} 是 object，必须给 properties（子字段）"))?;
        if map.len() > 32 {
            anyhow::bail!("{path}.properties 最多 32 项");
        }
        map.iter()
            .map(|(child, value)| parse_config_field(child, &format!("{path}.{child}"), value, depth + 1))
            .collect::<anyhow::Result<Vec<_>>>()?
    } else {
        Vec::new()
    };
    let format = match field.get("format") {
        None => None,
        Some(Value::String(format)) if format == "file" && kind == "string" => Some(format.clone()),
        Some(_) => anyhow::bail!("{path}.format 目前只支持 \"file\"，且只能用在 string 上"),
    };
    let extensions = match field.get("extensions") {
        None => Vec::new(),
        Some(Value::Array(items)) if format.is_some() && items.len() <= 20 => items
            .iter()
            .map(|item| match item.as_str() {
                Some(name) if !name.is_empty() && name.len() <= 10 && name.chars().all(|ch| ch.is_ascii_alphanumeric()) => {
                    Ok(name.to_ascii_lowercase())
                }
                _ => anyhow::bail!("{path}.extensions 的每一项是不带点的扩展名，如 \"png\""),
            })
            .collect::<anyhow::Result<Vec<_>>>()?,
        Some(_) => anyhow::bail!("{path}.extensions 只能和 format: \"file\" 一起用，最多 20 项"),
    };
    let mut result = ExtensionConfigField {
        key: key.to_string(),
        kind: kind.clone(),
        title: text("title", key)?,
        description: text("description", "")?,
        default: Value::Null,
        options,
        secret: field.get("secret").and_then(Value::as_bool).unwrap_or(false),
        min: bound("min")?,
        max: bound("max")?,
        items,
        properties,
        format,
        extensions,
    };
    result.default = match kind.as_str() {
        // 对象的默认值由子字段默认值组成；清单里写的 default 只用来覆盖其中的键。
        "object" => {
            let given = field.get("default").and_then(Value::as_object).cloned().unwrap_or_default();
            Value::Object(result.properties.iter().map(|child| (child.key.clone(), child.resolve(given.get(&child.key)))).collect())
        }
        _ => {
            let fallback = match kind.as_str() {
                "number" => match result.min { Some(min) if min > 0.0 => json!(min), _ => json!(0) },
                "boolean" => json!(false),
                "select" => result.options[0]["value"].clone(),
                "array" => json!([]),
                _ => json!(""),
            };
            match field.get("default") {
                Some(value) if result.accepts(value) => value.clone(),
                Some(_) => anyhow::bail!("{path}.default 与 type 不符"),
                None => fallback,
            }
        }
    };
    Ok(result)
}

/// 交给页面的配置：secret 项（含对象子字段、数组元素里的）换成 `null`。
///
/// 页面里官方脚本和拓展脚本同权，密钥放进页面就等于交给了页面里的所有代码；密钥只给后台。
pub fn strip_secret_config(schema: &[ExtensionConfigField], config: &Value) -> Value {
    fn strip_field(field: &ExtensionConfigField, value: &Value) -> Value {
        if field.secret {
            return Value::Null;
        }
        match (field.kind.as_str(), value) {
            ("object", Value::Object(_)) => strip_secret_config(&field.properties, value),
            ("array", Value::Array(items)) => match &field.items {
                Some(item) => Value::Array(items.iter().map(|value| strip_field(item, value)).collect()),
                None => value.clone(),
            },
            _ => value.clone(),
        }
    }
    let Some(map) = config.as_object() else {
        return config.clone();
    };
    Value::Object(
        map.iter()
            .map(|(key, value)| {
                let stripped =
                    schema.iter().find(|field| &field.key == key).map_or_else(|| value.clone(), |field| strip_field(field, value));
                (key.clone(), stripped)
            })
            .collect(),
    )
}

/// 校验要保存的配置：每个键都得声明过，值要合乎类型。
pub fn validate_config_values(schema: &[ExtensionConfigField], values: &Map<String, Value>) -> anyhow::Result<()> {
    for (name, value) in values {
        let field = schema.iter().find(|field| &field.key == name).with_context(|| format!("拓展没有声明配置项 {name}"))?;
        if !field.accepts(value) {
            anyhow::bail!("配置项 {name} 的值与类型 {} 不符", field.kind);
        }
    }
    Ok(())
}

/// 把新给的值并进已存的值：已存值里不再声明的键丢掉；secret 项传回打码值时保留原值。
pub fn merge_config_values(
    schema: &[ExtensionConfigField],
    stored: Option<&Map<String, Value>>,
    values: &Map<String, Value>,
) -> Map<String, Value> {
    let mut merged = stored.cloned().unwrap_or_default();
    merged.retain(|name, _| schema.iter().any(|field| &field.key == name));
    for (name, value) in values {
        let secret = schema.iter().any(|field| &field.key == name && field.secret);
        if secret && value.as_str() == Some(SECRET_MASK) {
            continue;
        }
        merged.insert(name.clone(), value.clone());
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema() -> Vec<ExtensionConfigField> {
        parse_extension_config_schema(Some(&json!({
            "minutes": { "type": "number", "default": 25, "min": 1, "max": 120 },
            "token": { "type": "string", "secret": true },
            "mode": { "type": "select", "options": ["a", "b"] },
            "proxy": { "type": "object", "properties": { "host": { "type": "string", "default": "localhost" }, "key": { "type": "string", "secret": true } } },
        })))
        .unwrap()
    }

    #[test]
    fn defaults_fill_in_and_bad_stored_values_fall_back() {
        let schema = schema();
        let stored = json!({ "minutes": 500, "mode": "b", "proxy": { "host": "example.com" } });
        let resolved = resolve_extension_config(&schema, stored.as_object());
        assert_eq!(resolved["minutes"], json!(25), "超出范围的已存值不用");
        assert_eq!(resolved["mode"], json!("b"));
        assert_eq!(resolved["token"], json!(""));
        assert_eq!(resolved["proxy"], json!({ "host": "example.com", "key": "" }));
    }

    #[test]
    fn schema_rejects_what_it_cannot_render() {
        for bad in [
            json!({ "x": { "type": "date" } }),
            json!({ "x": { "type": "select" } }),
            json!({ "x": { "type": "number", "default": "1" } }),
            json!({ "x y": { "type": "string" } }),
            json!({ "x": { "type": "array" } }),
        ] {
            assert!(parse_extension_config_schema(Some(&bad)).is_err(), "{bad}");
        }
        assert!(parse_extension_config_schema(None).unwrap().is_empty());
    }

    #[test]
    fn secrets_are_masked_for_display_and_dropped_for_the_page() {
        let schema = schema();
        let config = json!({ "minutes": 5, "token": "sk-1", "proxy": { "host": "h", "key": "k" } });
        let masked = mask_secret_config(&serde_json::to_value(&schema).unwrap(), &config);
        assert_eq!(masked["token"], json!(SECRET_MASK));
        assert_eq!(masked["proxy"]["key"], json!(SECRET_MASK));
        let page = strip_secret_config(&schema, &config);
        assert_eq!(page, json!({ "minutes": 5, "token": null, "proxy": { "host": "h", "key": null } }));
        assert!(!page.to_string().contains("sk-1"));
    }

    #[test]
    fn saving_validates_keys_and_keeps_masked_secrets() {
        let schema = schema();
        let stored = json!({ "token": "sk-1", "gone": 1 });
        let values = json!({ "token": SECRET_MASK, "minutes": 10 });
        assert!(validate_config_values(&schema, values.as_object().unwrap()).is_ok());
        let merged = merge_config_values(&schema, stored.as_object(), values.as_object().unwrap());
        assert_eq!(Value::Object(merged), json!({ "token": "sk-1", "minutes": 10 }));
        assert!(validate_config_values(&schema, json!({ "nope": 1 }).as_object().unwrap()).is_err());
        assert!(validate_config_values(&schema, json!({ "minutes": 0 }).as_object().unwrap()).is_err());
    }
}
