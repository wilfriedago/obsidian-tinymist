// A minimal template, so the fixture exercises `#show:` rules and imports.

#let paper(title: "", author: "", body) = {
  set page(width: 16cm, height: 22cm, margin: 1.6cm, numbering: "1")
  set text(size: 10pt)
  set heading(numbering: "1.1")

  align(center)[
    #text(size: 17pt, weight: "bold")[#title]
    #v(0.3em)
    #text(size: 10pt)[#author]
  ]
  v(1em)

  body
}
