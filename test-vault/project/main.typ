#import "template.typ": paper

#show: paper.with(
  title: "A multi-file Typst project",
  author: "Tinymist plugin fixtures",
)

= Introduction

This project has a `typst.toml`, so Tinymist's entry resolver treats
`test-vault/project/` as the project root rather than the vault root. That is
the case the plugin's "auto" project strategy exists to get right.

#figure(
  image("assets/diagram.svg", width: 60%),
  caption: [A figure loaded from a project-relative asset path.],
)

= Bibliography check

A cited claim @knuth1984.

#bibliography("bibliography.bib")
