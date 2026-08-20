#!/usr/bin/env node
// GitHub Issue Form の本文を accounts/<id>.json に変換する。
//
//   ISSUE_BODY="$(cat body.md)" node scripts/issue-to-json.mjs
//
// 成功時: accounts/<id>.json を書き出し、GITHUB_OUTPUT に id/username/created を出力
// 失敗時: 標準エラーに理由を出して exit 1（呼び出し元が Issue にコメントする）

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { appendFileSync } from "node:fs";
import { userByScreenName, tweetById, parseTweetUrl, parseHandleInput, today, sleep } from "./lib/x.mjs";
import { validateAccount, CATEGORIES } from "./lib/validate-core.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const ACCOUNTS_DIR = path.join(ROOT, "accounts");

/** Issue Form の本文を "### 見出し" 単位で分解する */
function parseIssueForm(body) {
  const sections = {};
  const parts = body.split(/^###\s+/m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf("\n");
    const heading = (nl === -1 ? part : part.slice(0, nl)).trim();
    const value = (nl === -1 ? "" : part.slice(nl + 1)).trim();
    sections[heading] = value === "_No response_" ? "" : value;
  }
  return sections;
}

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

async function main() {
  const body = process.env.ISSUE_BODY ?? (await readFile(0, "utf8"));
  if (!body.trim()) fail("Issue 本文が空です。");

  const s = parseIssueForm(body);

  // --- 対象アカウント ---
  const rawAccount = s["対象アカウント"] ?? "";
  const handle = parseHandleInput(rawAccount);
  if (!handle) {
    // なぜ弾かれたのかを具体的に返す（単なる「形式エラー」だと利用者が原因を特定できない）
    const bare = String(rawAccount).trim().replace(/^https?:\/\/(?:x|twitter)\.com\//i, "").replace(/^@/, "").split(/[/?#]/)[0];
    let reason = "`@username` または `https://x.com/username` の形式で記入してください。";
    if (bare.length > 15) {
      reason = `\`${bare}\` は ${bare.length} 文字です。X のユーザー名は **15文字以内** なので、この時点で存在し得ません。綴りを確認してください。`;
    } else if (/[^A-Za-z0-9_]/.test(bare)) {
      const bad = [...new Set(bare.match(/[^A-Za-z0-9_]/g))].join(" ");
      reason = `使用できない文字が含まれています: ${bad}\nX のユーザー名は半角英数字と \`_\` のみです（表示名ではなく @ から始まるハンドルを記入してください）。`;
    }
    fail(`対象アカウントを解釈できませんでした: \`${rawAccount}\`\n${reason}`);
  }

  // --- カテゴリ ---
  const categories = (s["カテゴリ"] ?? "")
    .split(/[,\n]/)
    // チェックボック形式だった場合に未チェック項目を拾わない
    .filter((c) => !/^\s*[-*]\s*\[\s\]/.test(c))
    .map((c) => c.trim().replace(/^[-*]\s*\[[xX]\]\s*/, ""))
    .map((c) => c.split(/\s+[—–-]\s+/)[0].trim())
    .filter(Boolean)
    .filter((c) => CATEGORIES.includes(c));
  if (categories.length === 0) {
    fail(`カテゴリが選択されていないか、未知の値です。有効なカテゴリ: ${CATEGORIES.join(", ")}`);
  }

  // --- 証拠 ---
  const evidenceUrls = (s["証拠ツイートURL"] ?? "")
    .split("\n")
    .map((l) => l.trim().replace(/^[-*]\s*/, ""))
    .filter(Boolean);
  if (evidenceUrls.length === 0) fail("証拠ツイートURLが1件も記入されていません。");

  const badUrls = evidenceUrls.filter((u) => !parseTweetUrl(u));
  if (badUrls.length > 0) {
    fail(`次のURLを解釈できませんでした:\n${badUrls.map((u) => `- \`${u}\``).join("\n")}\n\n\`https://x.com/<user>/status/<数字>\` の形式にしてください。`);
  }

  // --- 数値IDを解決 ---
  const user = await userByScreenName(handle);
  if (!user) {
    fail(`\`@${handle}\` を解決できませんでした。凍結・改名・削除、または綴り間違いの可能性があります。`);
  }

  // --- 証拠ツイートの投稿者が本人か照合 ---
  const evidence = [];
  const mismatches = [];
  const unavailable = [];
  for (const url of evidenceUrls) {
    const { tweetId } = parseTweetUrl(url);
    const tweet = await tweetById(tweetId).catch(() => null);
    await sleep(400);

    if (!tweet) {
      unavailable.push(url);
      continue;
    }
    if (tweet.authorId !== user.id) {
      mismatches.push(`- \`${url}\` の投稿者は @${tweet.authorUsername} (id=${tweet.authorId}) です`);
      continue;
    }
    evidence.push({ url: `https://x.com/${tweet.authorUsername}/status/${tweetId}` });
  }

  if (mismatches.length > 0) {
    fail(`証拠ツイートの投稿者が対象アカウント（@${user.username} / id=${user.id}）と一致しません:\n${mismatches.join("\n")}`);
  }
  if (evidence.length === 0) {
    fail(`証拠ツイートを1件も取得できませんでした（削除済み・非公開の可能性）:\n${unavailable.map((u) => `- \`${u}\``).join("\n")}\n\n魚拓URLを添えて手動でPRを送ってください。`);
  }

  // --- 既存エントリとのマージ ---
  await mkdir(ACCOUNTS_DIR, { recursive: true });
  const filePath = path.join(ACCOUNTS_DIR, `${user.id}.json`);
  const isNew = !existsSync(filePath);
  let existing = null;
  if (!isNew) {
    const raw = await readFile(filePath, "utf8");
    try {
      existing = JSON.parse(raw);
    } catch (e) {
      fail(`このアカウントの既存の掲載データを読み込めませんでした。メンテナの対応が必要です。(${e.message})`);
    }
  }

  const note = (s["補足"] ?? "").slice(0, 1000);
  const usernameHistory = new Set(existing?.username_history ?? []);
  if (existing && existing.username !== user.username) usernameHistory.add(existing.username);

  const mergedEvidence = [...(existing?.evidence ?? [])];
  for (const ev of evidence) {
    const id = parseTweetUrl(ev.url).tweetId;
    if (!mergedEvidence.some((e) => parseTweetUrl(e.url ?? "")?.tweetId === id)) {
      mergedEvidence.push(ev);
    }
  }

  const data = {
    $schema: "../schema/account.schema.json",
    id: user.id,
    username: user.username,
    ...(user.displayName ? { display_name: user.displayName } : {}),
    categories: [...new Set([...(existing?.categories ?? []), ...categories])],
    severity: existing?.severity ?? "medium",
    evidence: mergedEvidence,
    ...(note || existing?.note ? { note: note || existing.note } : {}),
    status: existing?.status ?? "listed",
    ...(usernameHistory.size > 0 ? { username_history: [...usernameHistory] } : {}),
    added_at: existing?.added_at ?? today(),
    updated_at: today(),
  };

  const { errors } = validateAccount(data, { filename: `${user.id}.json` });
  if (errors.length > 0) {
    fail(`入力内容に問題があります:\n${errors.map((e) => `- ${e}`).join("\n")}`);
  }

  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);

  const summary = [
    `id=${user.id}`,
    `username=${user.username}`,
    `created=${isNew}`,
    `evidence_added=${evidence.length}`,
  ];
  console.log(summary.join(" "));
  if (unavailable.length > 0) {
    console.log(`取得できなかったURL（スキップ）: ${unavailable.join(", ")}`);
  }

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `id=${user.id}`,
        `username=${user.username}`,
        `is_new=${isNew}`,
        `evidence_count=${mergedEvidence.length}`,
        `file=accounts/${user.id}.json`,
      ].join("\n") + "\n",
    );
  }
}

await main();
