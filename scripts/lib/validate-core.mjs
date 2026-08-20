// スキーマ検証（依存パッケージなし）。schema/account.schema.json と定義を揃えること。
import { parseTweetUrl } from "./x.mjs";

export const CATEGORIES = [
  "ai-hype",
  "ai-slop",
  "undisclosed-ai",
  "misinformation",
  "fake-demo",
  "plagiarism",
  "engagement-farming",
  "undisclosed-promo",
  "scam",
];

export const STATUSES = [
  "listed",
  "username-changed",
  "suspended",
  "deleted",
  "delisted",
];
export const SEVERITIES = ["low", "medium", "high"];

const ALLOWED_KEYS = new Set([
  "$schema",
  "id",
  "username",
  "display_name",
  "categories",
  "severity",
  "evidence",
  "note",
  "status",
  "username_history",
  "refs",
  "added_at",
  "updated_at",
  "last_checked_at",
]);

const RE_ID = /^[0-9]{1,25}$/;
const RE_USERNAME = /^[A-Za-z0-9_]{1,15}$/;
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;

// 個人情報の混入ガード（POLICY.md 参照）
const PII_PATTERNS = [
  { re: /[\w.+-]+@[\w-]+\.[\w.]+/, label: "メールアドレスらしき文字列" },
  { re: /\b0\d{1,4}-\d{1,4}-\d{3,4}\b/, label: "電話番号らしき文字列" },
  { re: /〒?\s*\d{3}-\d{4}/, label: "郵便番号らしき文字列" },
];

/**
 * 1件のアカウントデータを検証する（ネットワーク不要な部分のみ）。
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validateAccount(data, { filename } = {}) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { errors: ["ルートがオブジェクトではありません"], warnings };
  }

  for (const key of Object.keys(data)) {
    if (!ALLOWED_KEYS.has(key)) err(`未知のフィールド: "${key}"`);
  }

  // --- id ---
  if (typeof data.id !== "string" || !RE_ID.test(data.id)) {
    err(
      `id は数値文字列である必要があります（現在: ${JSON.stringify(data.id)}）`,
    );
  } else if (filename && filename !== `${data.id}.json`) {
    err(
      `ファイル名は "${data.id}.json" である必要があります（現在: "${filename}"）`,
    );
  }

  // --- username ---
  if (typeof data.username !== "string" || !RE_USERNAME.test(data.username)) {
    err(
      `username が不正です（@ は含めない・英数字と_のみ・15文字以内）: ${JSON.stringify(data.username)}`,
    );
  }

  if (data.display_name !== undefined) {
    if (
      typeof data.display_name !== "string" ||
      data.display_name.length > 100
    ) {
      err("display_name は100文字以内の文字列である必要があります");
    }
  }

  // --- categories ---
  if (!Array.isArray(data.categories) || data.categories.length === 0) {
    err("categories は1つ以上必要です");
  } else {
    const seen = new Set();
    for (const c of data.categories) {
      if (!CATEGORIES.includes(c)) {
        err(`未知のカテゴリ: "${c}"（有効: ${CATEGORIES.join(", ")}）`);
      }
      if (seen.has(c)) err(`カテゴリが重複しています: "${c}"`);
      seen.add(c);
    }
  }

  // --- severity / status ---
  if (data.severity !== undefined && !SEVERITIES.includes(data.severity)) {
    err(`severity が不正です（有効: ${SEVERITIES.join(", ")}）`);
  }
  if (data.status !== undefined && !STATUSES.includes(data.status)) {
    err(`status が不正です（有効: ${STATUSES.join(", ")}）`);
  }

  // --- evidence ---
  if (!Array.isArray(data.evidence) || data.evidence.length === 0) {
    err("evidence（証拠ツイート）は1件以上必須です");
  } else {
    const seenUrls = new Set();
    data.evidence.forEach((ev, i) => {
      const at = `evidence[${i}]`;
      if (typeof ev !== "object" || ev === null || Array.isArray(ev)) {
        err(`${at} はオブジェクトである必要があります`);
        return;
      }
      for (const key of Object.keys(ev)) {
        if (!["url", "note", "archive_url"].includes(key)) {
          err(`${at} に未知のフィールド: "${key}"`);
        }
      }
      const parsed = typeof ev.url === "string" ? parseTweetUrl(ev.url) : null;
      if (parsed) {
        if (seenUrls.has(parsed.tweetId))
          err(`${at}.url のツイートが重複しています`);
        seenUrls.add(parsed.tweetId);
      } else {
        err(
          `${at}.url が不正です。https://x.com/<user>/status/<id> 形式にしてください（現在: ${JSON.stringify(ev.url)}）`,
        );
      }
      if (
        ev.note !== undefined &&
        (typeof ev.note !== "string" || ev.note.length > 300)
      ) {
        err(`${at}.note は300文字以内の文字列である必要があります`);
      }
    });
  }

  // --- note / PII ---
  if (data.note !== undefined) {
    if (typeof data.note !== "string" || data.note.length > 1000) {
      err("note は1000文字以内の文字列である必要があります");
    }
  }
  const freeText = [
    data.note ?? "",
    ...(data.evidence ?? []).map((e) => e?.note ?? ""),
  ].join("\n");
  for (const { re, label } of PII_PATTERNS) {
    if (re.test(freeText)) {
      err(
        `個人情報の可能性がある記述が含まれています（${label}）。POLICY.md 参照。`,
      );
    }
  }

  // --- username_history / refs ---
  if (data.username_history !== undefined) {
    if (Array.isArray(data.username_history)) {
      for (const u of data.username_history) {
        if (typeof u !== "string" || !RE_USERNAME.test(u)) {
          err(`username_history に不正な値: ${JSON.stringify(u)}`);
        }
      }
    } else {
      err("username_history は配列である必要があります");
    }
  }
  if (data.refs !== undefined && !Array.isArray(data.refs)) {
    err("refs は配列である必要があります");
  }

  // --- dates ---
  for (const key of ["added_at", "updated_at"]) {
    if (typeof data[key] !== "string" || !RE_DATE.test(data[key])) {
      err(`${key} は YYYY-MM-DD 形式で必須です`);
    }
  }
  if (
    data.last_checked_at !== undefined &&
    !RE_DATE.test(String(data.last_checked_at))
  ) {
    err("last_checked_at は YYYY-MM-DD 形式である必要があります");
  }

  // --- warnings ---
  if (Array.isArray(data.evidence) && data.evidence.length === 1) {
    warnings.push(
      "証拠が1件のみです。2件以上あると常習性の判断が容易になります。",
    );
  }
  if (
    Array.isArray(data.evidence) &&
    !data.evidence.some((e) => e?.archive_url)
  ) {
    warnings.push(
      "archive_url（魚拓）が未設定です。ツイート削除に備えて推奨します。",
    );
  }

  return { errors, warnings };
}
