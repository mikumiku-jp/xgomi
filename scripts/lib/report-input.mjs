// 報告フォームの入力を解釈する。ネットワークには触らない。

import { classifyAccountInput, parseTweetUrl } from "./x.mjs";
import { CATEGORIES } from "./validate-core.mjs";

// 1つの Issue でまとめて報告できる上限。
// X への問い合わせと魚拓の取得が件数に比例して伸びるので、頭を打っておく。
export const MAX_ACCOUNTS = 10;

const lines = (raw) =>
  String(raw ?? "")
    .split("\n")
    .map((l) => l.trim().replace(/^[-*]\s*/, ""))
    .filter(Boolean);

/** 対象アカウント欄を解釈する。1行に1件。 */
export function parseAccounts(raw) {
  const targets = [];
  const invalid = [];
  const seen = new Set();
  for (const line of lines(raw)) {
    const c = classifyAccountInput(line);
    if (c.kind === "invalid") {
      invalid.push({ raw: line, reason: c.reason });
      continue;
    }
    const key = `${c.kind}:${c.value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ kind: c.kind, value: c.value, raw: line });
  }
  return { targets, invalid };
}

/** カテゴリ欄を解釈する。報告した全アカウントに同じものが付く。 */
export function parseCategories(raw) {
  return (
    String(raw ?? "")
      .split(/[,\n]/)
      // チェックボックス形式だった場合に未チェック項目を拾わない
      .filter((c) => !/^\s*[-*]\s*\[\s\]/.test(c))
      .map((c) => c.trim().replace(/^[-*]\s*\[[xX]\]\s*/, ""))
      .map((c) => c.split(/\s+[—–-]\s+/)[0].trim())
      .filter(Boolean)
      .filter((c) => CATEGORIES.includes(c))
  );
}

/** 証拠ツイート欄を解釈する。同じツイートの別表記は1件に畳む。 */
export function parseEvidence(raw) {
  const tweetIds = [];
  const unreadable = [];
  const seen = new Set();
  for (const line of lines(raw)) {
    const parsed = parseTweetUrl(line);
    if (!parsed) {
      unreadable.push(line);
      continue;
    }
    if (seen.has(parsed.tweetId)) continue;
    seen.add(parsed.tweetId);
    tweetIds.push(parsed.tweetId);
  }
  return { tweetIds, unreadable };
}

/**
 * 証拠ツイートを投稿者ごとに束ねる。
 * どのアカウントの証拠かは投稿者が決めるので、報告者に紐付けを書かせない。
 * @param tweets {{tweetId:string, authorId:string, authorUsername:string}[]}
 * @param users {{id:string, username:string}[]} 解決済みの対象アカウント
 */
export function groupEvidence(tweets, users) {
  const byUserId = new Map(users.map((u) => [u.id, []]));
  const orphans = [];
  for (const t of tweets) {
    const bucket = byUserId.get(t.authorId);
    if (bucket) bucket.push(t);
    else orphans.push(t);
  }
  const empty = users.filter((u) => byUserId.get(u.id).length === 0);
  return { byUserId, orphans, empty };
}

/** Issue タイトルやコミット件名に使う短い呼び名 */
export function describeAccounts(items) {
  const [first, ...rest] = items;
  if (!first) return "";
  return rest.length === 0 ? first : `${first} ほか${rest.length}件`;
}
