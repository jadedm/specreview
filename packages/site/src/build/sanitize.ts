// Every page's rendered Markdown passes through here before Vue compiles it
// as a template. VitePress's Markdown plugins put page text into places
// unescaped (code-group titles, alert titles, the code language label), and
// Vue would run any directive or {{ }} that reaches it. So nothing is trusted
// by plugin: only the tags, attributes and styles VitePress's own output for
// plain Markdown uses survive, links and images keep only http, https, mailto
// or relative URLs, and braces in text become entities.
import sanitizeHtml from 'sanitize-html';

const COLOUR = /^#[0-9a-fA-F]{3,8}$/;
const SHIKI = (prefix: string) => ({
  [`--shiki-${prefix}`]: [COLOUR],
  [`--shiki-${prefix}-font-style`]: [/^(italic|normal)$/],
  [`--shiki-${prefix}-font-weight`]: [/^(bold|normal|\d{3})$/],
  [`--shiki-${prefix}-text-decoration`]: [/^(underline|none|line-through)$/],
});
const HEADING = ['id', 'tabindex'];

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'p',
    'div',
    'span',
    'a',
    'code',
    'pre',
    'strong',
    'em',
    's',
    'nav',
    'ul',
    'ol',
    'li',
    'blockquote',
    'details',
    'summary',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'img',
    'button',
    'input',
    'label',
    'br',
    'hr',
  ],
  allowedAttributes: {
    h1: HEADING,
    h2: HEADING,
    h3: HEADING,
    h4: HEADING,
    h5: HEADING,
    h6: HEADING,
    a: ['class', 'href', 'aria-label', 'title', 'target', 'rel'],
    p: ['class'],
    div: ['class'],
    nav: ['class'],
    details: ['class'],
    span: ['class', 'style'],
    table: ['tabindex'],
    th: ['style'],
    td: ['style'],
    img: ['src', 'alt', 'title'],
    button: ['title', 'class'],
    // v-pre turns Vue compilation off for the code block; it is what keeps
    // code from being a template, so it stays.
    pre: ['class', 'tabindex', 'v-pre'],
    input: ['type', 'name', 'id', 'checked'],
    label: ['data-title', 'for'],
  },
  allowedStyles: {
    span: { ...SHIKI('light'), ...SHIKI('dark') },
    th: { 'text-align': [/^(left|right|center)$/] },
    td: { 'text-align': [/^(left|right|center)$/] },
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  allowProtocolRelative: false,
  // Code groups use radio inputs; no other input is part of a page.
  exclusiveFilter: (frame) => frame.tag === 'input' && frame.attribs.type !== 'radio',
  textFilter: (text) => text.replace(/\{/g, '&#123;').replace(/\}/g, '&#125;'),
};

export const sanitizeRendered = (html: string) => sanitizeHtml(html, OPTIONS);

// Text VitePress puts into the page with v-html (sidebar, previous and next
// links): escaped, so a page title is shown, never parsed.
export const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
