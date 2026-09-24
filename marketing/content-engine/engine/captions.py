"""Word-by-word karaoke captions as an ASS file, burned in by ffmpeg/libass."""
from __future__ import annotations

from .tts import Word

AMBER = "&H0000B3FF&"   # ASS colours are &HAABBGGRR -> #FFB300
WHITE = "&H00F4F2F2&"


def chunk_words(words: list[Word], max_words: int = 3, max_chars: int = 18, pause: float = 0.28) -> list[list[Word]]:
    """Group words into short caption lines; break after punctuation and at pauses (scene cuts)."""
    chunks: list[list[Word]] = []
    cur: list[Word] = []
    for w in words:
        if cur and (len(cur) >= max_words or len(" ".join(x.text for x in cur + [w])) > max_chars
                    or w.start - cur[-1].end > pause):
            chunks.append(cur)
            cur = []
        cur.append(w)
        if w.text.endswith((".", "!", "?", ",")):
            chunks.append(cur)
            cur = []
    if cur:
        chunks.append(cur)
    return chunks


def ts(t: float) -> str:
    t = max(0.0, t)
    h, rem = divmod(t, 3600)
    m, s = divmod(rem, 60)
    return f"{int(h)}:{int(m):02d}:{s:05.2f}"


def _esc(text: str) -> str:
    return text.replace("\\", "").replace("{", "(").replace("}", ")")


def build_ass(words: list[Word], width: int, height: int, font: str = "Segoe UI Black") -> str:
    margin_v = int(height * 0.25)  # sits above the bottom UI of TikTok/Reels/Shorts
    head = (
        "[Script Info]\nScriptType: v4.00+\nWrapStyle: 2\n"
        f"PlayResX: {width}\nPlayResY: {height}\nScaledBorderAndShadow: yes\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Cap,{font},92,{WHITE},{WHITE},&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,7,3,2,80,80,{margin_v},1\n\n"
        "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )
    lines = []
    chunks = chunk_words(words)
    for ci, chunk in enumerate(chunks):
        # A line may linger 0.12 s after its last word, but never overlap the next line
        # (overlapping events make libass stack two lines on screen).
        limit = chunks[ci + 1][0].start if ci + 1 < len(chunks) else float("inf")
        for i, w in enumerate(chunk):
            start = w.start
            end = chunk[i + 1].start if i + 1 < len(chunk) else min(w.end + 0.12, limit)
            parts = []
            for j, x in enumerate(chunk):
                t = _esc(x.text.upper())
                parts.append(f"{{\\c{AMBER}\\fscx108\\fscy108}}{t}{{\\c{WHITE}\\fscx100\\fscy100}}" if j == i else t)
            lines.append(f"Dialogue: 0,{ts(start)},{ts(end)},Cap,,0,0,0,,{' '.join(parts)}")
    return head + "\n".join(lines) + "\n"
