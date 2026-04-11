import * as fs from "fs/promises";
import * as path from "path";
import { randomUUID } from "crypto";

type StoreSupportAttachmentInput = {
  content: Buffer;
  originalFileName: string;
  mimeType: string;
  attachmentType: "image" | "video" | "audio" | "document" | "other";
  uploadedById: string;
};

type StoredSupportAttachment = {
  id: string;
  urlPath: string;
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
  attachmentType: "image" | "video" | "audio" | "document" | "other";
  uploadedById: string;
  createdAt: string;
};

function sanitizeFileName(raw: string): string {
  const cleaned = (raw || "")
    .trim()
    .replace(/[^\w.\-() ]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "attachment";
}

function extensionFromMime(mimeType: string): string {
  const mime = (mimeType || "").toLowerCase().split(";")[0].trim();
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/gif") return ".gif";
  if (mime === "video/mp4") return ".mp4";
  if (mime === "video/quicktime") return ".mov";
  if (mime === "audio/mpeg") return ".mp3";
  if (mime === "audio/wav") return ".wav";
  if (mime === "application/pdf") return ".pdf";
  if (mime === "text/plain") return ".txt";
  return "";
}

function ensureFileNameWithExtension(fileName: string, mimeType: string): string {
  if (/\.[a-z0-9]{2,6}$/i.test(fileName)) return fileName;
  const extension = extensionFromMime(mimeType);
  return extension ? `${fileName}${extension}` : fileName;
}

export async function storeSupportAttachmentBinary(
  input: StoreSupportAttachmentInput
): Promise<StoredSupportAttachment> {
  const now = new Date();
  const y = String(now.getUTCFullYear());
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const id = `att_${randomUUID().replace(/-/g, "")}`;
  const safeName = ensureFileNameWithExtension(sanitizeFileName(input.originalFileName), input.mimeType);
  const relativeDir = path.join(y, m, d);
  const absoluteDir = path.resolve(process.cwd(), "server_uploads", "support", relativeDir);
  await fs.mkdir(absoluteDir, { recursive: true });

  const fileName = `${id}_${safeName}`;
  const absolutePath = path.join(absoluteDir, fileName);
  await fs.writeFile(absolutePath, input.content);

  return {
    id,
    urlPath: `/support-attachments/${y}/${m}/${d}/${fileName}`,
    fileName: safeName,
    mimeType: input.mimeType,
    fileSizeBytes: input.content.length,
    attachmentType: input.attachmentType,
    uploadedById: input.uploadedById,
    createdAt: now.toISOString(),
  };
}
