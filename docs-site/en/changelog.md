# Changelog

The full changelog is maintained in the project repository:

- [English CHANGELOG](https://github.com/ayuayue/PiDeck/blob/main/CHANGELOG.md)
- [中文更新日志](https://github.com/ayuayue/PiDeck/blob/main/CHANGELOG.zh-CN.md)

## Unreleased

- 📱 **Phone / LAN web control** — Browse/reopen session history, create sessions, keep chatting, stop agents, switch models/thinking, and answer UI/trust prompts from a phone browser.
- 🔑 **QR pairing and token management** — Tokenized URL + QR code, copy, show/hide, rotation, and 1/7/30-day or never-expiring tokens.
- 🌐 **Remote access via Tailscale Serve** — One-click publish the loopback web service to your tailnet, with status, QR pairing, copy, and retry; only the Serve handler pointing at OmpDeck's local port is removed on exit.
- 🔒 **Loopback-only by default** — LAN access requires explicit opt-in; non-loopback API requests require a token, and only loopback addresses or the configured host are exempt, so arbitrary IP-literal Hosts and local reverse proxies that rewrite Host cannot bypass auth; writes check Origin, rate-limit, and cap request bodies.
- 📲 **Mobile layout and PWA** — Narrow-screen sidebar drawer, safe-area-aware composer, add-to-home-screen support; the service worker caches static assets only.
- ⚠️ Plain LAN HTTP is unencrypted. Prefer an HTTPS entry point such as Tailscale Serve or Cloudflare Tunnel for remote access, and never expose the port directly to the public internet.

## Latest Release

See the [GitHub Releases](https://github.com/ayuayue/PiDeck/releases) page for the latest version and download links.

## v0.6.7 (highlights)

- Compact titlebar + Codex-style right sidebar; file editor nested under Files
- File tree drag/drop/move; @ file tree suggestions; path chips with spaces
- Batch ask Tab UI; session message Fork; boot splash pi assembly animation
- Single-instance window reuse; startup window size presets (default maximized)
- Compaction settings UI; LaTeX/math fences; Electron Chromium sandbox toggle
- Fixes: pet stuck states (#107), titlebar sidebar toggles (#104), stop afterglow,
  built-in extension disable cleanup, manual compact state, clipboard focus

Contributors this cycle: **@1900EasonJin** (#104, #107), **@zzq168281-coder** (#103), **@me9rez** (#97), **@weishiair**, **@clancyclaw**
