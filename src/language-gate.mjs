const BLOCKED_SCRIPT_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Devanagari}\p{Script=Thai}]/gu;

export function cleanMarkdownForLanguageCheck(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[[^\]]+]\([^)]+\)/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#>*_|~=[\]()-]/g, " ");
}

export function assessEnglishContent(...parts) {
  const cleaned = cleanMarkdownForLanguageCheck(parts.filter(Boolean).join("\n\n"));
  const letters = cleaned.match(/\p{Letter}/gu) || [];
  if (letters.length < 12) {
    return { status: "unknown", confidence: null };
  }

  const latinLetters = cleaned.match(/\p{Script=Latin}/gu) || [];
  const blockedLetters = cleaned.match(BLOCKED_SCRIPT_PATTERN) || [];
  const latinRatio = latinLetters.length / letters.length;
  const blockedRatio = blockedLetters.length / letters.length;

  if (blockedLetters.length >= 20 && blockedRatio >= 0.15) {
    return { status: "rejected", confidence: roundConfidence(1 - blockedRatio) };
  }

  if (letters.length >= 80 && latinRatio < 0.65) {
    return { status: "rejected", confidence: roundConfidence(latinRatio) };
  }

  if (latinRatio >= 0.72) {
    return { status: "accepted", confidence: roundConfidence(latinRatio) };
  }

  return { status: "unknown", confidence: roundConfidence(latinRatio) };
}

function roundConfidence(value) {
  return Math.round(value * 1000) / 1000;
}
