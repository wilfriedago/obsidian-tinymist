#import "imports/shared.typ": accent, callout, project-name

#set page(width: 12cm, height: 8cm, margin: 1cm)

= Imports

This document imports #raw(project-name) from a sibling file, so it exercises
multi-file resolution without a `typst.toml`.

#callout[
  Text inside a callout defined in `imports/shared.typ`.
]

#text(fill: accent)[Accent-coloured text.]
