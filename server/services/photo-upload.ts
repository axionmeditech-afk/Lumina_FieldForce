import { createCipheriv, createHash, randomBytes } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

function getEncryptionKey(): Buffer {
  const raw = process.env.PHOTO_ENCRYPTION_KEY || "trackforce-photo-default-key";
  return createHash("sha256").update(raw).digest();
}

async function saveEncryptedLocal(fileName: string, fileBuffer: Buffer): Promise<string> {
  const uploadsDir = path.resolve(process.cwd(), "server_uploads", "attendance");
  await fs.mkdir(uploadsDir, { recursive: true });
  const iv = randomBytes(12);
  const key = getEncryptionKey();
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(fileBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, authTag, encrypted]);
  const fullPath = path.join(uploadsDir, `${fileName}.enc`);
  await fs.writeFile(fullPath, payload);
  return fullPath;
}

async function uploadToS3IfConfigured(
  key: string,
  payload: Buffer,
  contentType = "application/octet-stream"
): Promise<string | null> {
  const bucket = process.env.AWS_S3_BUCKET;
  const region = process.env.AWS_REGION;
  if (!bucket || !region) return null;

  try {
    // Optional dependency. If SDK is unavailable, fallback to local encrypted storage.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
    const client = new S3Client({ region });
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: payload,
        ContentType: contentType,
        ServerSideEncryption: "AES256",
      })
    );
    return `s3://${bucket}/${key}`;
  } catch {
    return null;
  }
}

export async function storeAttendancePhoto(
  base64: string,
  mimeType: string,
  userId: string,
  photoType: "checkin" | "checkout"
): Promise<string> {
  const fileBuffer = Buffer.from(base64, "base64");
  const fileName = `${userId}_${photoType}_${Date.now()}`;

  const s3Key = `attendance/${new Date().toISOString().slice(0, 10)}/${fileName}.enc`;
  const localEncryptedPayload = await saveEncryptedLocal(fileName, fileBuffer);
  const localBuffer = await fs.readFile(localEncryptedPayload);
  const s3Location = await uploadToS3IfConfigured(s3Key, localBuffer, mimeType);

  return s3Location ?? localEncryptedPayload;
}
