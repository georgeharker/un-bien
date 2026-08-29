import { convertToPng } from "@earendil-works/pi-coding-agent";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Image codec + on-disk preview paths for received images — the pure(ish)
 * encode/decode/validate/path layer, split from the stateful preview-DELIVERY
 * logic (queueing/broadcast) that stays in index.ts. Owns its own temp-dir
 * cache. `convertToPng` normalizes any supported mime to a PNG preview.
 */

export const RECEIVED_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_PREVIEW_MIME = "image/png";
const IMAGE_CACHE_PREFIX = "pi-app-";
let _imageCacheDir: string | undefined;

function _isBase64Char(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 43 || // +
    code === 47
  ); // /
}

function _isStrictBase64(data: string): boolean {
  if (data.length === 0 || data.length % 4 !== 0) return false;
  if (data.startsWith("=")) return false;

  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  for (let i = 0; i < data.length; i += 1) {
    const code = data.charCodeAt(i);
    if (i >= data.length - padding) {
      if (code !== 61) return false;
      continue;
    }
    if (!_isBase64Char(code)) return false;
  }

  return true;
}

export function _imageCacheRootDir(): string {
  if (_imageCacheDir) {
    try {
      mkdirSync(_imageCacheDir, { recursive: true, mode: 0o700 });
    } catch {}
    try {
      chmodSync(_imageCacheDir, 0o700);
    } catch {
      /* best-effort permission hardening */
    }
    return _imageCacheDir;
  }
  const dir = mkdtempSync(join(tmpdir(), IMAGE_CACHE_PREFIX));
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best-effort permission hardening */
  }
  _imageCacheDir = dir;
  return dir;
}

export function _imageExtension(mime: string): string | undefined {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  return undefined;
}

export function _safeFilenameToken(value: string): string {
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "") || "message"
  );
}

export function _safePreviewPath(
  dir: string,
  messageId: string,
  index: number,
): string {
  return join(dir, `${_safeFilenameToken(messageId)}-${index}.preview.png`);
}

export function _cleanupPreviewFile(previewPath: string): void {
  try {
    if (existsSync(previewPath)) unlinkSync(previewPath);
  } catch {
    // best effort
  }
}

export async function _renderablePngPathFromImage(
  imageData: string,
  mime: string,
  previewPath: string,
): Promise<string | undefined> {
  if (mime === IMAGE_PREVIEW_MIME) return undefined;

  try {
    const converted = await convertToPng(imageData, mime);
    if (
      !converted ||
      converted.mimeType !== IMAGE_PREVIEW_MIME ||
      !converted.data
    ) {
      return undefined;
    }

    const previewBytes = Buffer.from(converted.data, "base64");
    if (
      previewBytes.length === 0 ||
      previewBytes.length > RECEIVED_IMAGE_MAX_BYTES
    ) {
      return undefined;
    }

    try {
      writeFileSync(previewPath, previewBytes, { mode: 0o600 });
      try {
        chmodSync(previewPath, 0o600);
      } catch {
        /* best-effort permission hardening */
      }
      return previewPath;
    } catch {
      _cleanupPreviewFile(previewPath);
    }
  } catch {
    _cleanupPreviewFile(previewPath);
  }

  return undefined;
}

export function _decodeImagePayload(
  data: string,
  mime: string,
): { ok: true; decoded: Buffer; size: number } | { ok: false; reason: string } {
  if (!_imageExtension(mime))
    return { ok: false, reason: `unsupported mime: ${mime}` };
  if (data.startsWith("data:"))
    return { ok: false, reason: "data URI payloads are not supported" };
  if (!_isStrictBase64(data))
    return { ok: false, reason: "invalid base64 payload" };

  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const estimate = (data.length / 4) * 3 - padding;
  if (estimate > RECEIVED_IMAGE_MAX_BYTES) {
    return { ok: false, reason: `image too large (${estimate} bytes)` };
  }

  const decoded = Buffer.from(data, "base64");
  if (decoded.length === 0 || decoded.length > RECEIVED_IMAGE_MAX_BYTES) {
    return {
      ok: false,
      reason: `invalid decoded image size (${decoded.length} bytes)`,
    };
  }

  return { ok: true, decoded, size: decoded.length };
}
