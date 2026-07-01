import express, { type Express } from "express";

export type SupportRouteDeps = Record<string, any>;

export function registerSupportRoutes(app: Express, deps: SupportRouteDeps) {
  const {
    requireAuth,
    firstString,
    normalizeSupportAttachmentType,
    storeSupportAttachmentBinary,
  } = deps;
  const maxAttachmentMb = Math.max(20, Number(process.env.MAX_SUPPORT_ATTACHMENT_MB || 150));

  app.post(
    "/api/support/attachments/upload",
    requireAuth,
    express.raw({ type: "*/*", limit: `${maxAttachmentMb}mb` }),
    async (req, res) => {
      const uploaderId = req.auth?.sub;
      if (!uploaderId) {
        res.status(401).json({ message: "Not authenticated" });
        return;
      }

      const body = req.body;
      const fileBuffer = Buffer.isBuffer(body) ? body : null;
      if (!fileBuffer || fileBuffer.length === 0) {
        res.status(400).json({ message: "Attachment payload is required." });
        return;
      }

      const rawFileName = decodeURIComponent(firstString(req.header("x-file-name")) || "attachment");
      const mimeType = firstString(req.header("content-type")) || "application/octet-stream";
      const attachmentType = normalizeSupportAttachmentType(firstString(req.header("x-attachment-type")));

      try {
        const stored = await storeSupportAttachmentBinary({
          content: fileBuffer,
          originalFileName: rawFileName,
          mimeType,
          attachmentType,
          uploadedById: uploaderId,
        });
        const forwardedProto = firstString(req.header("x-forwarded-proto")) || req.protocol || "https";
        const forwardedHost = firstString(req.header("x-forwarded-host")) || req.get("host") || "";
        const routedUrlPath = stored.urlPath.startsWith("/api/")
          ? stored.urlPath
          : `/api${stored.urlPath}`;
        const absoluteUrl = forwardedHost
          ? `${forwardedProto}://${forwardedHost}${routedUrlPath}`
          : routedUrlPath;
        res.status(201).json({
          id: stored.id,
          url: absoluteUrl,
          name: stored.fileName,
          mimeType: stored.mimeType,
          sizeBytes: stored.fileSizeBytes,
          attachmentType: stored.attachmentType,
          uploadedById: stored.uploadedById,
          createdAt: stored.createdAt,
        });
      } catch (error) {
        res.status(500).json({
          message:
            error instanceof Error
              ? `Unable to store support attachment: ${error.message}`
              : "Unable to store support attachment.",
        });
      }
    }
  );


}
