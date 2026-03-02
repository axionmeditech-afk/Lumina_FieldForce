#!/usr/bin/env python3
import argparse
import json
import os
import sys
from typing import Any, Dict, List, Optional, Tuple


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Local STT + optional diarization")
    parser.add_argument("--audio", required=True, help="Path to input audio file")
    parser.add_argument("--model", default="small", help="faster-whisper model size/path")
    parser.add_argument("--language", default="", help="Language code, e.g. en, hi, gu")
    parser.add_argument("--with-diarization", action="store_true", help="Enable speaker diarization")
    parser.add_argument("--with-timestamps", action="store_true", help="Include timestamps")
    parser.add_argument("--num-speakers", type=int, default=0, help="Expected number of speakers")
    parser.add_argument("--format", default="json", choices=["json"], help="Output format")
    return parser.parse_args()


def load_transcription_model(model_name: str) -> Any:
    try:
        from faster_whisper import WhisperModel
    except Exception as exc:
        raise RuntimeError(
            "faster-whisper is not installed. Run: npm run stt:python:setup"
        ) from exc
    device = os.getenv("LOCAL_STT_DEVICE", "cpu")
    compute_type = os.getenv("LOCAL_STT_COMPUTE_TYPE", "int8")
    return WhisperModel(model_name, device=device, compute_type=compute_type)


def transcribe_audio(
    model: Any, audio_path: str, language: Optional[str]
) -> Tuple[List[Dict[str, Any]], str]:
    segments, _info = model.transcribe(
        audio_path,
        language=language or None,
        beam_size=5,
        vad_filter=True,
        word_timestamps=False,
    )

    segment_rows: List[Dict[str, Any]] = []
    texts: List[str] = []
    for seg in segments:
        text = (seg.text or "").strip()
        if not text:
            continue
        start = float(seg.start or 0.0)
        end = float(seg.end or start)
        segment_rows.append(
            {
                "start": max(0.0, start),
                "end": max(start, end),
                "text": text,
            }
        )
        texts.append(text)

    transcript = " ".join(texts).strip()
    return segment_rows, transcript


def run_diarization(
    audio_path: str, segments: List[Dict[str, Any]], expected_speakers: int
) -> List[Optional[str]]:
    if not segments:
        return []
    max_speakers = max(1, expected_speakers) if expected_speakers > 0 else 2

    def heuristic_labels() -> List[Optional[str]]:
        labels: List[Optional[str]] = []
        current = 1
        last_end = 0.0
        current_streak = 0.0
        for seg in segments:
            start = float(seg.get("start", 0.0))
            end = float(seg.get("end", start))
            duration = max(0.0, end - start)
            gap = max(0.0, start - last_end)
            should_switch = max_speakers > 1 and (gap >= 1.1 or current_streak >= 14.0)
            if should_switch:
                current = (current % max_speakers) + 1
                current_streak = 0.0
            labels.append(str(current))
            current_streak += duration
            last_end = end
        return labels

    try:
        import numpy as np
        import librosa
        from resemblyzer import VoiceEncoder  # type: ignore
        from sklearn.cluster import KMeans  # type: ignore
    except Exception:
        return heuristic_labels()

    try:
        audio, sample_rate = librosa.load(audio_path, sr=16000, mono=True)
    except Exception:
        return heuristic_labels()

    if sample_rate <= 0 or audio is None or len(audio) == 0:
        return heuristic_labels()

    encoder = VoiceEncoder()
    emb_vectors: List[np.ndarray] = []
    emb_indices: List[int] = []
    min_frames = int(0.6 * sample_rate)

    for idx, seg in enumerate(segments):
        start = int(float(seg.get("start", 0.0)) * sample_rate)
        end = int(float(seg.get("end", 0.0)) * sample_rate)
        start = max(0, start)
        end = min(len(audio), max(start, end))
        if end - start < min_frames:
            continue
        clip = audio[start:end]
        try:
            emb = encoder.embed_utterance(clip)
        except Exception:
            continue
        if emb is None:
            continue
        emb_vectors.append(np.asarray(emb))
        emb_indices.append(idx)

    if not emb_vectors:
        return heuristic_labels()

    num_available = len(emb_vectors)
    if expected_speakers > 0:
        n_clusters = min(max(1, expected_speakers), num_available)
    else:
        n_clusters = 2 if num_available >= 4 else 1

    if n_clusters <= 1:
        labels = np.zeros(num_available, dtype=int)
    else:
        kmeans = KMeans(n_clusters=n_clusters, random_state=42, n_init=10)
        labels = kmeans.fit_predict(np.vstack(emb_vectors))

    speaker_map: List[Optional[str]] = [None for _ in segments]
    for seg_idx, label in zip(emb_indices, labels):
        speaker_map[seg_idx] = str(int(label) + 1)

    # Fill gaps using last known speaker to avoid null segments.
    last_seen = speaker_map[0] or "1"
    for i in range(len(speaker_map)):
        if speaker_map[i] is None:
            speaker_map[i] = last_seen
        else:
            last_seen = speaker_map[i] or last_seen
    return speaker_map


def build_output(
    transcript: str,
    model_name: str,
    segments: List[Dict[str, Any]],
    with_timestamps: bool,
    speakers: List[Optional[str]],
) -> Dict[str, Any]:
    entries: List[Dict[str, Any]] = []
    for idx, seg in enumerate(segments):
        speaker = speakers[idx] if idx < len(speakers) else None
        row: Dict[str, Any] = {
            "transcript": seg["text"],
            "speaker_id": speaker or "1",
        }
        if with_timestamps:
            row["start_time_seconds"] = round(float(seg["start"]), 3)
            row["end_time_seconds"] = round(float(seg["end"]), 3)
        entries.append(row)

    return {
        "provider": "local_python",
        "model": model_name,
        "transcript": transcript,
        "diarized_transcript": {"entries": entries} if entries else {"entries": []},
    }


def main() -> int:
    args = parse_args()
    if not os.path.isfile(args.audio):
        sys.stderr.write(f"Audio file not found: {args.audio}\n")
        return 2

    try:
        model = load_transcription_model(args.model)
        segments, transcript = transcribe_audio(
            model=model,
            audio_path=args.audio,
            language=(args.language.strip() or None),
        )
        if not transcript:
            payload = {
                "provider": "local_python",
                "model": args.model,
                "transcript": "",
                "diarized_transcript": {"entries": []},
            }
            sys.stdout.write(json.dumps(payload, ensure_ascii=False))
            return 0

        speakers = (
            run_diarization(args.audio, segments, args.num_speakers)
            if args.with_diarization
            else ["1" for _ in segments]
        )
        payload = build_output(
            transcript=transcript,
            model_name=args.model,
            segments=segments,
            with_timestamps=args.with_timestamps,
            speakers=speakers,
        )
        sys.stdout.write(json.dumps(payload, ensure_ascii=False))
        return 0
    except Exception as exc:
        sys.stderr.write(f"local_stt_error: {exc}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
