// A long document for moving through the preview: scrolling line by line and
// jumping page by page. Every page says which page it is, large enough to read
// at a glance, so it is obvious where a key press landed.
//
// Most pages are A5 portrait. Chapter 4 has a landscape page and chapter 5 a
// short one, because a jump to the next page should land on its top whatever
// the sizes around it.

#set document(title: "A long document")
#set page(
  paper: "a5",
  margin: (x: 1.8cm, top: 2.4cm, bottom: 2cm),
  header: context {
    let here = counter(page).get().first()
    let total = counter(page).final().first()
    set text(size: 9pt, fill: luma(110))
    [A long document #h(1fr) Page #here of #total]
    line(length: 100%, stroke: 0.4pt + luma(180))
  },
  footer: context {
    set align(center)
    set text(size: 22pt, weight: "bold", fill: luma(200))
    counter(page).display()
  },
)
#set text(size: 10.5pt)
#set par(justify: true)
#set heading(numbering: "1.1")
#show heading.where(level: 1): it => {
  pagebreak(weak: true)
  v(1.5cm)
  text(size: 20pt, it)
  v(0.5cm)
}

#align(center + horizon)[
  #text(size: 26pt, weight: "bold")[A long document]

  #v(0.4cm)
  For testing navigation in the preview

  #v(1.2cm)
  #set align(left)
  #set text(size: 9.5pt)
  - *Up / Down* should scroll a line's worth, and keep going across page breaks.
  - *Left / Right* should land on the top of the previous or next page.
  - The large number at the bottom of each page is the page you are on.
]

#pagebreak()
#outline(depth: 1)

= Prose that runs across pages

Long paragraphs, so the text keeps flowing past the bottom of one page and onto
the next. Scrolling a line at a time should feel continuous through the page
break.

#for i in range(1, 9) [
  #lorem(140)

]

= Lists and numbered steps

#for i in range(1, 4) [
  == Group #i

  + #lorem(18)
  + #lorem(24)
  + #lorem(12)
    - #lorem(10)
    - #lorem(14)
  + #lorem(20)

]

#lorem(160)

= Tables

#for n in range(1, 4) [
  == Table #n

  #table(
    columns: (auto, 1fr, auto),
    align: (right, left, right),
    table.header([*\#*], [*Item*], [*Value*]),
    ..range(1, 19).map(i => ([#i], [#lorem(4)], [#(i * n * 7)])).flatten(),
  )

]

= Mixed page sizes

The next page is landscape, and the one after is short. A jump to the next
page should land on its top regardless.

#lorem(60)

#page(flipped: true)[
  == A landscape page

  #lorem(120)
]

#page(height: 9cm)[
  == A short page

  #lorem(30)
]

== Back to A5

#lorem(200)

= Mathematics

#for i in range(1, 7) [
  The sum of the first $n$ odd numbers is a square:
  $ sum_(k=1)^n (2k - 1) = n^2 $

  #lorem(50)

  $ integral_0^infinity e^(-x^2) dif x = sqrt(pi) / 2 $

  #lorem(40)

]

= The last chapter

#lorem(220)

#pagebreak()
#align(center + horizon)[
  #text(size: 18pt, weight: "bold")[The end]

  Right should do nothing here: this is the last page.
]
