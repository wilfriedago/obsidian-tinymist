# Accessibility

Writing a thesis, a paper, or a CV should not depend on how you see, move, or
read. This plugin aims to let anyone who can use Obsidian write, preview, and
export Typst documents in it. It also aims to let anyone who can use Obsidian
help build the plugin.

This document explains what the plugin prioritizes, what we ask of
contributions, how to report a barrier, and what is known not to work yet. If
you are here because something got in your way, go straight to
[Reporting accessibility issues](#reporting-accessibility-issues).

## Priorities

There is no formal conformance target, and the plugin has not had an
accessibility evaluation. What it works toward:

- **Everything works from the keyboard.** The plugin's actions are commands,
  so the command palette reaches them, and you can give any of them a hotkey:
  open or toggle the preview, export a PDF, format, create a file, or restart
  Tinymist. The exceptions are listed under
  [Known limitations](#known-limitations).
- **The plugin follows your Obsidian setup.** Colors, fonts, and font sizes come
  from Obsidian's theme variables, so a high-contrast theme, a larger font, or a
  CSS snippet applies to the plugin too. The editor's selection uses your accent
  color at a strength that keeps the selected text readable in light and dark
  themes.
- **Color is never the only signal.** The status bar shows Tinymist's state as
  text and an icon, as well as a color. Errors and warnings in the editor have
  a gutter marker as well as an underline.
- **Controls have names.** Icon-only buttons, such as the preview's refresh,
  pin, and open-source buttons, and the status bar item, carry a label that a
  screen reader can announce.

## Contributor expectations

For a change that people will see or use:

- **Make it reachable without a mouse.** A new action is a command, not only a
  button or a menu entry.
- **Name icon-only controls,** with `aria-label`, the way the preview's buttons
  are named.
- **Take colors from Obsidian's CSS variables** rather than fixed values, and
  check the change in a light and a dark theme.
- **Do not use color alone to carry meaning.** Pair it with text, an icon, or a
  shape.
- **Say what you checked.** The pull request template asks how a change was
  verified in a real vault. For a user-facing change, include how you checked
  it with the keyboard, and with a screen reader if you used one.

CI runs lint, type checks, and the test suite, but it runs no automated
accessibility checks. The manual checks above are the safeguard.

## Reporting accessibility issues

[Open an issue](https://github.com/wilfriedago/obsidian-tinymist/issues/new/choose)
with the bug report template, and say in the title that it is about
accessibility, so the maintainer can add the `accessibility` label. If a
question in the template does not apply, or you cannot answer it, write "not
applicable" and move on.

These details help, if you have them:

- what you were trying to do, such as preview a document or fix an error
- what happened instead
- your operating system, and your Obsidian and plugin versions
- any assistive technology you use, such as a screen reader, a magnifier,
  voice control, or a switch

Screenshots and recordings are welcome, but optional. You never need to say
whether you have a disability. To ask for help rather than report a problem,
use [Discussions](https://github.com/wilfriedago/obsidian-tinymist/discussions).

### Severity

You do not need to choose a severity. The maintainer sets it while triaging the
issue:

- **Blocker:** you cannot complete a task at all. For example, the preview
  cannot be opened from the keyboard.
- **Major:** you can complete the task, but only with a workaround or much more
  effort. For example, you can read an error only by hovering over it with the
  mouse.
- **Minor:** the task works, but something gets in the way. For example, a
  control is announced with a vague name.

### How we respond

This is a spare-time project with one maintainer, so these are aims rather
than guarantees:

- A reply to a new accessibility issue within a week.
- A workaround, if one exists, in that reply.
- Blockers before other bugs, and before new features.
- A comment on the issue when a fix ships, asking you to confirm whether it
  works for you.

## Ownership and maintenance

The maintainer, [@wilfriedago](https://github.com/wilfriedago), is responsible
for accessibility: triaging reports, reviewing pull requests against the
expectations above, and keeping this document accurate. This document is
reviewed when a release changes the plugin's interface, and at least once a
year. If maintenance moves to someone else, this section will name them.

## Supported environments

- **Obsidian:** desktop, version 1.13.0 or later. The plugin does not run on
  mobile.
- **Operating systems:** macOS, Windows, and Linux, which Obsidian desktop
  supports. Development and manual testing happen on macOS. Windows and Linux
  are expected to work, but are less tested.
- **Input:** keyboard and mouse. Commands and hotkeys go through Obsidian's own
  command palette and hotkey settings.
- **Assistive technology:** no screen reader, magnifier, or voice-control
  software has been tested with the plugin yet. Reports from people using them
  are especially welcome.

## Known limitations

- **Keys pressed in the preview do not scroll it, and the preview cannot be
  scrolled from outside.** The rendered document is in an isolated frame that
  Obsidian cannot reach. To move through a document, scroll with the mouse or
  trackpad, or move the caret in the editor: the preview follows it when
  **Sync with the editor** is on. This is on the
  [roadmap](ROADMAP.md#keyboard-navigation-in-the-preview).
- **A screen reader may not be able to read the rendered preview,** and the
  preview's frame is not yet given a name to announce. The exported PDF is the
  same document, and it opens in Obsidian's own PDF viewer.
- **Pinning the preview to one document is a button in the preview, not a
  command,** so it has no hotkey and is not in the command palette.
- **An error's message opens only by hovering over it with the mouse.** The
  underline and the gutter marker show where the error is, but no keyboard
  command opens the message yet.
- **Obsidian's outline, backlinks, and tags do not work for `.typ` files.**
  A document outline is on the [roadmap](ROADMAP.md#document-outline).

## Feedback and improvements

To suggest a change to this document or to how the project handles
accessibility, open a pull request or start a thread in
[Discussions](https://github.com/wilfriedago/obsidian-tinymist/discussions).
If something is in your way right now, use the
[reporting process](#reporting-accessibility-issues) instead, so it gets
triaged as a bug.
