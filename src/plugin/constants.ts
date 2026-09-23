/** The file extension of a Typst document. */
export const TYPST_EXTENSION = 'typ';

/** A BibLaTeX bibliography, which Typst reads through `#bibliography`. */
export const BIBLATEX_EXTENSION = 'bib';

/**
 * A Hayagriva bibliography, Typst's own YAML format.
 *
 * Opt-in, because claiming these claims every YAML file in the vault, and most
 * YAML is not a bibliography. New files use the first; both are claimed.
 */
export const HAYAGRIVA_EXTENSIONS = ['yml', 'yaml'] as const;
