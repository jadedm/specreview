// Which published files may stay in a reader's browser (#104). Asset URLs
// carry no version (the hub resolves the live one), so only a file whose name
// changes with its content may be kept: Vite's scripts and stylesheets,
// <name>.<8-character hash>.js|css under assets/, and Mermaid's files in the
// folder the site build names for its version (#102). The hub takes a name of
// that shape as a content hash; it does not hash the bytes itself. The site
// build's tests check that every script and stylesheet it writes, page chunks
// aside, passes.
//
// Page chunks (<page>.md.<hash>[.lean].js) hold the page's text and are never
// kept: a year on disk would outlast a reader's removal and a sign-out on a
// shared browser. What qualifies is code and style with no page text: the app
// entry, the framework, the theme, the stylesheet and Mermaid.
const CONTENT_ADDRESSED = [
  /^assets\/(?:[^/]+\/)*(?![^/]*\.md\.)[^/]+\.[A-Za-z0-9_-]{8}\.(?:js|css)$/,
  /^assets\/mermaid-\d+\.\d+\.\d+\/(?:[^/]+\/)*[^/]+\.mjs$/,
];

export const isContentAddressed = (path: string): boolean => CONTENT_ADDRESSED.some((re) => re.test(path));
