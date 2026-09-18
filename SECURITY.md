# Security policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting:
[**Report a vulnerability**](https://github.com/wilfriedago/obsidian-tinymist/security/advisories/new).
It is private to the maintainers until an advisory is published, and it gives
you a thread to discuss the fix.

Please include what you can:

- what an attacker gains, and what they need in order to try
- steps or a `.typ` file that reproduces it
- the plugin version, your Obsidian version, and `tinymist -V`

You will get an acknowledgement within **7 days**. This is a single-maintainer
project, not a company with an on-call rota, so please read that as a genuine
best effort rather than a contractual promise. If a report is valid, the fix
and an advisory follow as soon as is practical, and you are credited unless you
would rather not be.

## Supported versions

Only the latest release is supported. Fixes ship in a new version rather than
as patches to older ones.

| Version | Supported |
| --- | --- |
| Latest release | ✅ |
| Anything older | ❌ — please update |

## What this plugin can do

Useful context for judging a report. The plugin's capabilities are deliberately
narrow, and each is verifiable in the built `main.js`.

**It launches one external program.** `child_process.spawn` starts the Tinymist
executable, always with `shell: false` and an argument array. No shell is
invoked, so nothing from a document, a filename, or a setting can be
interpreted as a command. It runs no program other than the executable resolved
from your settings or `PATH`.

**It has no filesystem access.** The bundle imports exactly one Node module,
`node:child_process`. There is no `node:fs`, so the plugin cannot read file
contents, write, or delete outside Obsidian's Vault API. Verify with:

```sh
grep -o 'require("node:[^"]*")' main.js   # node:child_process, and nothing else
```

**It makes no network requests.** No `fetch`, `XMLHttpRequest`, `WebSocket`, or
`requestUrl` in the bundle. No telemetry, no analytics, no remote code or
styles.

**The preview is isolated by origin.** Rendered documents load in an `<iframe>`
pointed at Tinymist's loopback server, which is a different origin from
Obsidian's `app://`. The same-origin policy stops rendered content reaching
Obsidian's DOM, its APIs, or the vault. No document-derived markup is inserted
into Obsidian's own page; text the plugin renders goes through `textContent`.

**Untrusted input is treated as such.** A `.typ` file, its imports, and
anything Tinymist reports about them are untrusted. Paths from settings are
contained so they cannot escape the vault, and values loaded from `data.json`
are validated rather than trusted.

## Known and accepted

These are documented rather than fixed, and are not news:

- **The preview server has no authentication.** Tinymist binds it to
  `127.0.0.1` on an ephemeral port while a preview tab is open. It is not
  reachable from other machines, but on a shared machine another local process
  could read a document you are previewing. This matches the upstream editor
  integration's behaviour.
- **Tinymist runs with your privileges.** It is a compiler you installed, doing
  what compilers do. A vulnerability *in Tinymist or Typst* belongs
  [upstream](https://github.com/Myriad-Dreamin/tinymist/security).
- **Typst packages are fetched by Tinymist.** The first `#import` from a
  package makes Tinymist download it. That is Typst's behaviour, outside this
  plugin's control, and the only route by which anything here reaches the
  internet.

See [docs/risks.md](docs/risks.md) for the wider list, including weak points
that are not security issues.

## Scope

**In scope:** anything that lets a `.typ` file, a vault, or a crafted Tinymist
response reach beyond the boundaries above — escaping the vault, executing a
command, reaching Obsidian's APIs from rendered content, or exfiltrating data.

**Out of scope:** vulnerabilities in Tinymist, Typst, Obsidian, or CodeMirror
themselves (report those upstream); anything requiring an attacker to already
have code execution on your machine; and the accepted items listed above.

## Supply chain

- Releases are built by GitHub Actions from a tagged commit, and `main.js` and
  `styles.css` carry a
  [build provenance attestation](https://github.com/wilfriedago/obsidian-tinymist/attestations).
- `main.js` is a plain esbuild bundle. It is minified, never obfuscated, and
  the full source is in this repository.
- The plugin does not self-update, and never downloads or updates Tinymist.
- Runtime dependencies are kept to one: `codemirror-lang-typst`, for syntax
  highlighting. Dependabot watches it.
