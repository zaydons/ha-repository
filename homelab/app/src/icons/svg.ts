// Content checks for icon bytes that did not come from the bundled packs.
//
// Icons are always shown with <img> (scripts never run there) and served with
// `default-src 'none'` + nosniff, but the icons route shares HA's origin, so a
// user could still open an SVG directly. We therefore refuse (rather than try
// to rewrite) any SVG with active content or external references. Real icon
// SVGs from dashboard-icons/selfh.st have none of these.

const UNSAFE_SVG: readonly RegExp[] = [
  /<\s*script/i,
  /<\s*foreignObject/i,
  /<\s*(iframe|embed|object|audio|video|handler|listener)\b/i,
  /<!ENTITY/i,
  /<\?xml-stylesheet/i,
  /\son[a-z]+\s*=/i, // event handler attributes
  /javascript\s*:/i,
  /@import/i,
  // Any href that is not an in-document fragment or an embedded raster image.
  /\bhref\s*=\s*(["'])(?!\s*#|\s*data:image\/(png|jpe?g|gif|webp);)/i,
  /url\(\s*(["']?)(?!\s*#|\s*data:image\/(png|jpe?g|gif|webp);)/i,
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
