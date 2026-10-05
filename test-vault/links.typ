// Every path below opens its file with Mod-click (Cmd on macOS, Ctrl
// elsewhere), or in a new tab with Mod-Shift-click.

#import "imports/shared.typ": accent

#set page(width: 14cm, height: auto, margin: 1cm)

= Linked files

#let fixtures = read("README.md")
#let references = yaml("hayagriva/references.yml")

#text(fill: accent)[The vault README is #fixtures.len() characters long, and
cites #references.len() work.]

#image("project/assets/diagram.svg", width: 40%)

#include "imports/shared.typ"
