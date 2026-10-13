// Content checks for icon bytes that did not come from the bundled packs.
//
// Icons are always shown with <img> (scripts never run there) and served with
// `default-src 'none'` + nosniff, but the icons route shares HA's origin, so a
// user could still open an SVG directly. We therefore refuse (rather than try
// to rewrite) any SVG with active content or external references. Real icon
// SVGs from dashboard-icons/selfh.st have none of these.

// An optional XML namespace prefix ("s:script", "x:onload"). XML names may use
// non-ASCII characters, so the prefix is "anything that can't end a name".
const PFX = String.raw`(?:[^\s:<>/"'=]+:)?`;
// A same-document reference or an embedded raster image; anything else is external.
// The lookahead also covers the optional opening quote, so backtracking over
// the quote can't turn a safe "#a" into a match.
const SAFE_REF = String.raw`(?!\s*["']?\s*(?:#|data:image\/(?:png|jpe?g|gif|webp);))`;

const UNSAFE_SVG: readonly RegExp[] = [
  // Active or embedding elements, with or without a namespace prefix (V1).
  new RegExp(String.raw`<\s*\/?\s*${PFX}(?:script|foreignObject|iframe|embed|object|audio|video|handler|listener)(?![^\s/>])`, "i"),
  // Event-handler attributes, with or without a prefix (onload=, x:onload=).
  new RegExp(String.raw`[\s"'/]${PFX}on[^\s=/>]*\s*=`, "i"),
  // Any href / xlink:href / x:href that is not same-document or an embedded raster.
  new RegExp(String.raw`[\s"'/]${PFX}href\s*=${SAFE_REF}`, "i"),
  new RegExp(String.raw`url\(${SAFE_REF}`, "i"),
  // SMIL animation that rewrites a link target (<set attributeName="xlink:href" to="...">).
  new RegExp(String.raw`attributeName\s*=\s*["']\s*${PFX}href`, "i"),
  // XHTML content (any element bound to the XHTML namespace can carry scripts).
  /http:\/\/www\.w3\.org\/1999\/xhtml/i,
  /<!ENTITY/i,
  /<!DOCTYPE[^>]*\[/i,
  /<\?(?!xml\s)/i, // processing instructions other than the XML declaration
  /javascript\s*:/i,
  /@import/i,
];

export function isSafeSvg(body: Buffer): boolean {
  const text = body.toString("utf8");
  if (!/<svg[\s>]/i.test(text)) return false;
  return !UNSAFE_SVG.some((re) => re.test(text));
}

/** Check that bytes look like the image type the file extension claims. */
export function matchesType(body: Buffer, contentType: string): boolean {
  switch (contentType) {
    case "image/png":
      return body.length > 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/webp":
      return body.length > 12 && body.toString("latin1", 0, 4) === "RIFF" && body.toString("latin1", 8, 12) === "WEBP";
    case "image/svg+xml":
      return isSafeSvg(body);
    default:
      return false;
  }
}

/**
 * Give a bundled single-colour glyph a fill colour (`-#rrggbb` in Homepage
 * syntax). `colour` must already match /^[0-9a-f]{6}$/i.
 */
export function colourSvg(body: Buffer, colour: string): Buffer {
  if (!/^[0-9a-fA-F]{6}$/.test(colour)) return body;
  const text = body.toString("utf8");
  const out = text.replace(/<svg\b/, `<svg fill="#${colour.toLowerCase()}"`);
  return Buffer.from(out, "utf8");
}
