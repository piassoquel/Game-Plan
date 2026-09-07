import { randomUUID } from "node:crypto";
import { getStorage } from "firebase-admin/storage";
import { HttpsError } from "firebase-functions/v2/https";

/**
 * Upload a base64 data URL to the default bucket and return a Firebase-style
 * download URL. Used server-side for now (photo comes in the callable payload);
 * Phase 4 moves capture to a direct client -> Storage upload.
 */
export async function uploadDataUrl(dataUrl, path) {
  const m = String(dataUrl || "").match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!m) throw new HttpsError("invalid-argument", "Invalid image.");
  const contentType = m[1];
  const buffer = Buffer.from(m[2], "base64");
  if (buffer.length > 8 * 1024 * 1024) throw new HttpsError("invalid-argument", "Photo is too large.");

  const token = randomUUID();
  const bucket = getStorage().bucket();
  const file = bucket.file(path);
  await file.save(buffer, {
    resumable: false,
    contentType,
    metadata: { metadata: { firebaseStorageDownloadTokens: token } },
  });
  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
}
