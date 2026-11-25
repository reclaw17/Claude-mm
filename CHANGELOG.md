# Changelog

**[English](CHANGELOG.md) · [简体中文](CHANGELOG.zh-CN.md) · [Русский](CHANGELOG.ru.md)**

## 0.1.14 - 2026-11-22

- Projects now work: you can create projects in Chat (it no longer says "Projects aren't available right now"), set project instructions, and add text, Word / Excel / PowerPoint documents, PDFs and images to project knowledge. In conversations started inside a project, the request to the model includes the project instructions and all of its knowledge. Projects, their knowledge and the conversations inside them are stored on this machine and survive a restart; projects can be renamed, starred, archived and deleted, and conversations moved into and out of them. Knowledge is not retrieved by search: all of it is sent to the model in every conversation, so a lot of knowledge takes up context and costs more (a cache marker has been added, which saves part of the cost when the upstream supports prompt caching). PDFs and images are sent to the model as the original files, which requires the upstream to support PDF / image input. Sync sources such as Google Drive and GitHub, and sharing with other people, are not supported.
- Extension marketplace: the Extensions page gained a marketplace where you can search for, install and update extensions. "Officially reviewed" extensions live in the claude-mom-extensions repository, and their code was reviewed before being merged; "Community" extensions come from the authors' own repositories, nobody has reviewed them, and you are asked to confirm once more before installing. An extension newly installed from the marketplace is enabled right away, and updating keeps its on/off switch as it was; when an installed extension has a new version, you are notified.
- In extension manifests, `author` and `description` set to `null` are no longer treated as a format error.

## 0.1.13 - 2026-11-22

- Page extensions: ClaudeMom gained an Extensions page where you can add your own scripts and styles to the Claude page. Two example extensions are bundled (Desk Pet Little Orange and Wide Chat Area), off by default; you can also import a .zip or a folder with a manifest.json. Turning extensions on or off, importing or deleting them takes effect on the next refresh of the Claude page, with no restart.
- The ClaudeMom interface now uses left-hand navigation: Upstreams / Claude Settings / Extensions; the version and the update check moved to the bottom of the sidebar.
- With OpenCode Go as the upstream, Chat and Cowork no longer report "400 MissingSessionID": requests sent to opencode.ai carry a session identifier (`x-opencode-session`) that stays the same within a conversation, so the upstream's cache can be hit. (#42)
- In Settings → Memory, saving memories and toggling the memory switch no longer show "Unable to save memory". Local mode has no memory synthesis and model requests do not carry memories; changes made here only last for the current run. (#43)
- Opening the Projects page no longer fails the whole page because of the conversation list's format. (#40)

## 0.1.12 - 2026-11-20

- When only a system proxy is set (no TUN mode), model requests sent to public upstreams now go through that proxy too, instead of connecting directly and being rejected by the upstream for the region (`403 region_blocked`) or failing to connect. Upstreams on this machine or on the local network still connect directly. (#36)

## 0.1.11 - 2026-11-20

- Connectors now work: connectors in the Plugins page (remote MCP servers; Product Hunt and Notion were tested, other connectors that let clients register themselves are connected the same way) can be opened and connected with "Add", after which newly created Cowork and Code sessions can call their tools; they can also be disconnected and removed. Connectors that need a login open the provider's authorization page in the system browser and return to Claude automatically after login; tokens are stored on this machine. Connectors that only accept Anthropic's own registered clients (Slack, Gmail, Google Drive, Asana, etc.) cannot be logged into and report a connection failure right away. Connector tools do not take effect in the Chat tab yet.
- Search in the Plugins page is fixed: in 0.1.10 it only ever listed installed plugins, whatever you searched for.
- The "Connectors" section of the plugin details page no longer shows loading forever; opening a connector from the list no longer reports "Unable to load this page".

## 0.1.10 - 2026-11-20

- Plugins can be installed now: plugins in the Plugins page that have a source repository (Skills / hooks / commands such as Superpowers or frontend-design) can be opened to see details and files and installed with "Add"; once installed, they can be used in newly created Cowork and Code sessions and can be removed. Plugin details come from Anthropic's public directory, and the package is the source of the reviewed commit in the plugin's GitHub repository, so installing requires access to GitHub. Connector entries (the kind invoked on your behalf by Anthropic's servers) still cannot be opened or installed. (#25)
- macOS: fixed Cowork reporting "401 Invalid bearer token" in the Recorded UI. Requests from the virtual machine now go through the local service instead of connecting to the official servers directly via the system proxy. The virtual machine only accepts certificates trusted under the basic policy: with Cowork on, anyone who trusted the local certificate before has to click "Trust certificate" once more.
- Fixed "Cowork is currently unavailable" when submitting a Cowork task: added `/api/bootstrap/<org>/system_prompts` and wrote `system_prompts` into bootstrap. The prompts are read at runtime from the local `app.asar` (the official text is not distributed in the repository); when they cannot be read, a built-in fallback is used.
- Fixed the Plugins page failing entirely with "Unable to load plugins. Please check your internet connection and try again" (introduced in 0.1.9): the plugin directory is displayed again, and shows as empty when Anthropic cannot be reached. (#25)
- When a Chat conversation is reopened after the local service restarts, it keeps the model selected last time instead of switching back to the default model.

## 0.1.9 - 2026-11-18

- Fixed existing replies showing "Unable to load this content" in the 11-17 UI. When old or new conversations lack lists such as attachments, an empty list is now returned; existing attachments are not cleared. The list of frame types read by the page has been completed as well. (#26, thanks to #29 for the investigation)
- Fixed the plugin page's directory, registry, extension list and installed-plugin check endpoints missing required fields; with no local plugins, an empty list is shown. The Recorded UI's local mock does not include official plugin details or packages, so this release does not add browsing or installing official plugins. (#25, #30)
- The model list can now be fetched from upstreams whose address ends in `/anthropic`, such as DeepSeek: when the original model list endpoint returns 404 or 405, the model list at the root path is tried; an authentication failure or timeout is reported as an error directly. (#20)

## 0.1.8 - 2026-11-17

- Fixed upstream models in the picker all showing "Upgrade" and erroring on every switch when using the 11-17 UI (no need to switch back to the 11-07 version).
- Windows: requests from the Cowork virtual machine now go through the local service instead of connecting to the official servers directly and reporting "401 Invalid bearer token".
- Windows: a new "Install system certificate" button under Settings → Advanced → Cowork (requires administrator approval). The Cowork virtual machine only trusts system-level certificates and reports an x509 certificate error without it; untrusting the local certificate removes the system-level one as well.

## 0.1.7 - 2026-11-17

- Fixed the home page input missing the "Chats | Cowork" switch, which made Cowork impossible to find.
- UI data updated to the claude.ai version of 2026-11-17; Settings → Version lets you switch back to the earlier 11-07 version.
- Settings → Interface gained "Built-in": it uses Claude's own new interface (third-party mode), updates together with Claude and needs no trust for the local certificate; the Chinese UI and voice input are not supported yet, and account-related features such as computer use are absent. The default remains "Recorded".
- Settings gained "Merged home page (experimental)": the home page Claude is trialling with a small share of users, with chats and Cowork combined in one input box; off by default.
- Removed "Use the built-in interface of this machine (experimental)", replaced by "Built-in".

## 0.1.6 - 2026-11-16

- Chat and Cowork conversation titles are now generated by the upstream model instead of always saying "New task" or staying untitled; conversations can be renamed and deleted.
- Fixed an issue where some Chat requests lost the question text after compression.
- Windows: fixed dictation never connecting (voice service 503).
- Fixed the "Invalid BFF response format" error when submitting a Cowork task.
- Fixed the Artifacts "policy check couldn't get through" error.
- The local service now prefers the system-installed Node.js (22+) instead of borrowing the one bundled with ChatGPT / Codex; it falls back to those only if the system version is too old.

## 0.1.5 - 2026-11-16

- Fixed "unable to download Claude Code (IDLE_TIMEOUT)" on first use of Code / Cowork: large files are now converted while downloading instead of being read fully into memory (memory no longer grows to several GB during a download).
- Fixed "connection to Claude's reply interrupted" right after sending a Chat message: when the upstream fails (wrong Key, nonexistent model, non-standard gateway response, etc.), the upstream's own reason is now shown in the reply; gateways that use CRLF separators, omit end events, or don't stream are supported too.
- Windows: fixed the Settings → Computer Use prompt "computer use is not enabled for your account".
- Windows / macOS: when another user on the same machine has Claude open, it is no longer mistaken for your own instance stuck at "running".
- Fixed empty messages when opening an existing conversation.
- Built-in sample skills (which cannot be downloaded in local mode) are no longer shown as enabled, and Claude stops trying to download them on every sync and reporting a failure.

## 0.1.4 - 2026-11-16

- Fixed the local service opening thousands of connections on first launch (seen as a flood of node connections in proxies and firewalls): requests to the upstream now share connections and limit concurrency.
- Fixed a fresh install sometimes getting a different UI layout with the Code tab stuck on loading; the first launch no longer requires direct access to claude.ai, reducing "Couldn't connect to Claude / Bad Gateway".
- When Claude closes a connection, the local service closes its side too, so connections no longer pile up; connections to other domains (stats, error reporting) now go through the system proxy.
- Settings → Advanced gained "Use the built-in interface of this machine (experimental)" — off by default, for testing only.

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
