export const telegramPhotoMaxBytes = 10 * 1024 * 1024;

const mediaExtensions = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp"
} as const;

export function decodeTelegramPhoto(image: { base64: string; mediaType: string }) {
  const extension = mediaExtensions[image.mediaType as keyof typeof mediaExtensions];
  if (!extension) {
    throw new Error(`Unsupported Telegram photo media type: ${image.mediaType}`);
  }

  const encoded = image.base64;
  const maximumEncodedCharacters = Math.ceil(telegramPhotoMaxBytes / 3) * 4;
  const paddingAt = encoded.indexOf("=");
  const invalidPadding =
    encoded.length % 4 !== 0 ||
    (paddingAt >= 0 && (encoded.length - paddingAt > 2 || /[^=]/.test(encoded.slice(paddingAt))));
  if (!encoded || encoded.length > maximumEncodedCharacters || /[^A-Za-z0-9+/=]/.test(encoded) || invalidPadding) {
    throw new Error("Generated image has invalid or oversized base64 data");
  }

  const bytes = Buffer.from(encoded, "base64");
  const canonical = bytes.toString("base64").replace(/=+$/, "");
  if (!bytes.length || bytes.length > telegramPhotoMaxBytes || canonical !== encoded.replace(/=+$/, "")) {
    throw new Error("Generated image has invalid or oversized base64 data");
  }
  if (!matchesSignature(bytes, image.mediaType)) {
    throw new Error(`Generated image bytes do not match ${image.mediaType}`);
  }

  return { bytes, extension, mediaType: image.mediaType as keyof typeof mediaExtensions };
}

function matchesSignature(bytes: Buffer, mediaType: string) {
  if (mediaType === "image/png") {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mediaType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  return (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  );
}
