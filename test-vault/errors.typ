// This file is meant to FAIL to compile.
// It is the diagnostics fixture: the plugin must surface every error below,
// each mapped back to its own line and column.

= Broken document

// 1. Unknown function.
#this-function-does-not-exist()

// 2. Wrong argument type for a known parameter.
#text(size: "not-a-length")[oops]

// 3. Unknown variable in an expression.
#(undefined-variable + 1)

// 4. Missing file in an import.
#import "does-not-exist.typ": anything
