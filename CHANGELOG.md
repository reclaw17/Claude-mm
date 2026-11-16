# Changelog

**[English](CHANGELOG.md) · [简体中文](CHANGELOG.zh-CN.md) · [Русский](CHANGELOG.ru.md)**

## 0.1.3 - 2026-11-15

- Windows: fixed the issue where newer Claude Desktop builds had no "Chats | Cowork" switch on the home page; Cowork now opens by default. If you don't want it, turn it off in Settings → Advanced → Cowork.
- Some Claude versions ship without `ion-dist.asar` and unpack the UI into a directory instead — the local service used to fail to start and keep showing "local service not running". Both layouts are now supported.

## 0.1.2 - 2026-11-13

- Import from cc-switch: now also reads providers configured specifically for Claude Desktop (the "Claude Desktop" page in newer cc-switch versions); identical address + Key pairs are imported only once.
- Import from cc-switch: the database is located by cc-switch's own rules, so a custom config directory set in its settings is found too.
- When cc-switch only contains OpenAI-format providers, the reason is now explained instead of a bare "not found".

## 0.1.1 - 2026-11-12

- macOS: Claude is now launched by the system (LaunchServices), so privacy permissions like screen recording and accessibility are computed by Claude itself and no longer show as "not requested".
- Settings → Advanced gained "Enable background mode on newer systems" (off by default): when Claude says "background mode not supported yet" on recent macOS, this lifts the system-version restriction. Not validated by Claude — may be unstable.

## 0.1.0 - 2026-11-12

First release: a standalone program split out of CodexPlusPlus.

- Full-featured mode of the original Claude Desktop (Chat / Code / Cowork, Chinese UI) talking directly to your own upstream (Base URL + Key).
- Multiple upstreams with instant switching; import Claude providers from cc-switch, or use the local gateways of Magpie / Codex++ as upstreams.
- Local dictation (SenseVoice, offline transcription).
- Auto-update.
