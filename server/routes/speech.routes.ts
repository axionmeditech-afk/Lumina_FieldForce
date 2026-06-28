import express, { type Express } from "express";

export type SpeechRouteDeps = Record<string, any>;

export function registerSpeechRoutes(app: Express, deps: SpeechRouteDeps) {
  const {
    MAX_TRANSCRIBE_AUDIO_BYTES,
    firstString,
    transcribeSpeechWithFairseqS2T,
    Speech2TextError,
  } = deps;

  app.post(
    "/api/speech/transcribe",
    express.raw({ type: "*/*", limit: `${MAX_TRANSCRIBE_AUDIO_BYTES}b` }),
    async (req, res) => {
      const rawBody = req.body;
      const audioBuffer = Buffer.isBuffer(rawBody) ? rawBody : null;
      if (!audioBuffer || audioBuffer.length === 0) {
        res.status(400).json({ message: "Audio payload is required." });
        return;
      }
      if (audioBuffer.length > MAX_TRANSCRIBE_AUDIO_BYTES) {
        res.status(413).json({ message: "Audio payload too large." });
        return;
      }

      const mimeTypeHeader = firstString(req.header("content-type"));
      const mimeType = mimeTypeHeader.split(";")[0]?.trim() || "audio/webm";
      const model = firstString(req.query.model) || null;
      const fallbackModel = firstString(req.query.fallback_model) || null;
      const provider = firstString(req.query.provider) || null;
      const mode = firstString(req.query.mode) || null;
      const languageCode = firstString(req.query.language_code) || null;
      const withDiarizationRaw = firstString(req.query.with_diarization) || null;
      const withTimestampsRaw = firstString(req.query.with_timestamps) || null;
      const numSpeakersRaw = firstString(req.query.num_speakers) || null;
      const groqApiKeyHeader = firstString(req.header("x-groq-api-key"));
      const withDiarization =
        withDiarizationRaw === null
          ? null
          : /^(1|true|yes|on)$/i.test(withDiarizationRaw.trim());
      const withTimestamps =
        withTimestampsRaw === null
          ? null
          : /^(1|true|yes|on)$/i.test(withTimestampsRaw.trim());
      const parsedNumSpeakers = numSpeakersRaw ? Number(numSpeakersRaw) : Number.NaN;
      const numSpeakers = Number.isFinite(parsedNumSpeakers)
        ? Math.max(1, Math.floor(parsedNumSpeakers))
        : null;

      try {
        const result = await transcribeSpeechWithFairseqS2T({
          audio: audioBuffer,
          mimeType,
          model,
          fallbackModel,
          provider,
          mode,
          languageCode,
          withDiarization,
          withTimestamps,
          numSpeakers,
          groqApiKey:
            groqApiKeyHeader ||
            firstString(req.query.groq_api_key) ||
            null,
        });
        res.json(result);
      } catch (error) {
        if (error instanceof Speech2TextError) {
          const speechError = error as { statusCode: number; message: string };
          res.status(speechError.statusCode).json({ message: speechError.message });
          return;
        }
        const message =
          error instanceof Error ? error.message : "Speech transcription failed unexpectedly.";
        res.status(500).json({ message });
      }
    }
  );


}
