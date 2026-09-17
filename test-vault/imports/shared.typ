// Shared definitions imported by other fixtures.

#let accent = rgb("#4051b5")

#let callout(body) = block(
  fill: accent.lighten(85%),
  inset: 8pt,
  radius: 4pt,
  width: 100%,
  body,
)

#let project-name = "Tinymist fixtures"
