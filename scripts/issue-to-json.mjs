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
import {
  userByScreenName,
  tweetById,
  parseTweetUrl,
  classifyAccountInput,
  archiveUrl,
  today,
  sleep,
} from "./lib/x.mjs";
import { validateAccount, CATEGORIES } from "./lib/validate-core.mjs";
import { parseIssueForm } from "./lib/issue-form.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const ACCOUNTS_DIR = path.join(ROOT, "accounts");

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

/**
 * 入力と証拠ツイートから対象アカウントを確定する。
 * 数値IDで報告された場合は直接引けないので、証拠ツイートの投稿者から逆引きする。
 */
async function resolveTarget(target, tweetIds) {
  const byHandle = async (handle) => {
    const u = await userByScreenName(handle).catch((e) =>
      fail(`X への問い合わせに失敗しました: ${e.message}\n時間をおいて再度お試しください。`),
    );
    return u;
  };

  if (target.kind === "handle") {
    const u = await byHandle(target.value);
    if (!u) {
      fail(
        `\`@${target.value}\` を見つけられませんでした。凍結・改名・削除、または綴り間違いの可能性があります。`,
      );
    }
    return u;
  }

  // 数値IDとして扱う。証拠ツイートの投稿者がそのIDなら、現在のハンドルが分かる
  const tryNumeric = async () => {
    for (const tweetId of tweetIds) {
      const tweet = await tweetById(tweetId).catch(() => null);
      await sleep(400);
      if (tweet && tweet.authorId === target.value && tweet.authorUsername) {
        const u = await byHandle(tweet.authorUsername);
        if (u && u.id === target.value) return u;
      }
    }
    return null;
  };

  if (target.kind === "numeric-id") {
    const u = await tryNumeric();
    if (!u) {
      fail(
        `数値ID \`${target.value}\` の現在のユーザー名を特定できませんでした。\n記入した証拠ツイートがこのIDの投稿ではないか、削除されています。対象アカウントには \`@username\` を記入してください。`,
      );
    }
    return u;
  }

  // ambiguous: 数字だけの短い入力。ユーザー名としても数値IDとしても読める
  const asHandle = await byHandle(target.value);
  if (asHandle) return asHandle;
  const asId = await tryNumeric();
  if (asId) return asId;
  fail(
    `\`${target.value}\` はユーザー名としても数値IDとしても見つかりませんでした。対象アカウントには \`@username\` を記入してください。`,
  );
}

async function main() {
  const body = process.env.ISSUE_BODY ?? (await readFile(0, "utf8"));
  if (!body.trim()) fail("Issue 本文が空です。");

  const s = parseIssueForm(body);

  // --- 対象アカウント ---
  const rawAccount = s["対象アカウント"] ?? "";
  const target = classifyAccountInput(rawAccount);
  if (target.kind === "invalid") {
    fail(
      `対象アカウントを解釈できませんでした: \`${rawAccount}\`\n${target.reason}\n\n\`@username\` または \`https://x.com/username\` の形式で記入してください。`,
    );
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
    fail(
      `カテゴリが選択されていないか、未知の値です。有効なカテゴリ: ${CATEGORIES.join(", ")}`,
    );
  }

  // --- 証拠 ---
  const evidenceUrls = (s["証拠ツイートURL"] ?? "")
    .split("\n")
    .map((l) => l.trim().replace(/^[-*]\s*/, ""))
    .filter(Boolean);
  if (evidenceUrls.length === 0)
    fail("証拠ツイートURLが1件も記入されていません。");

  const badUrls = evidenceUrls.filter((u) => !parseTweetUrl(u));
  if (badUrls.length > 0) {
    fail(
      `次のURLを解釈できませんでした:\n${badUrls.map((u) => `- \`${u}\``).join("\n")}\n\n\`https://x.com/<user>/status/<数字>\` の形式にしてください。`,
    );
  }

  // 同じツイートが別の書き方（ミラーや ?s=20 付き）で並んでいることがある
  const uniqueTweets = [];
  const seenTweetIds = new Set();
  for (const u of evidenceUrls) {
    const { tweetId } = parseTweetUrl(u);
    if (seenTweetIds.has(tweetId)) continue;
    seenTweetIds.add(tweetId);
    uniqueTweets.push(tweetId);
  }

  // --- 対象アカウントを確定 ---
  const user = await resolveTarget(target, uniqueTweets);
  if (user.protected) {
    fail(
      `\`@${user.username}\` は鍵アカウントです。第三者が内容を検証できないため、掲載対象外です（POLICY.md）。`,
    );
  }

  // --- 証拠ツイートの投稿者が本人か照合 ---
  const evidence = [];
  const mismatches = [];
  const unavailable = [];
  for (const tweetId of uniqueTweets) {
    const tweet = await tweetById(tweetId).catch(() => null);
    await sleep(400);

    if (!tweet) {
      unavailable.push(`https://x.com/i/status/${tweetId}`);
      continue;
    }
    if (tweet.authorId !== user.id) {
      mismatches.push(
        `- \`https://x.com/${tweet.authorUsername}/status/${tweetId}\` の投稿者は @${tweet.authorUsername} (id=${tweet.authorId}) です`,
      );
      continue;
    }
    const url = `https://x.com/${tweet.authorUsername}/status/${tweetId}`;
    // 投稿を消されても検証できるよう、この時点で魚拓を押さえておく。
    // 失敗しても報告自体は通す（後で archive ワークフローが拾う）
    const archived = await archiveUrl(url);
    evidence.push(archived ? { url, archive_url: archived } : { url });
  }

  if (mismatches.length > 0) {
    fail(
      `証拠ツイートの投稿者が対象アカウント（@${user.username} / id=${user.id}）と一致しません:\n${mismatches.join("\n")}`,
    );
  }
  if (evidence.length === 0) {
    fail(
      `証拠ツイートを1件も取得できませんでした（削除済み・非公開の可能性）:\n${unavailable.map((u) => `- \`${u}\``).join("\n")}\n\n魚拓URLを添えて手動でPRを送ってください。`,
    );
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
      fail(
        `このアカウントの既存の掲載データを読み込めませんでした。メンテナの対応が必要です。(${e.message})`,
      );
    }
  }

  const note = (s["補足"] ?? "").slice(0, 1000);
  const usernameHistory = new Set(existing?.username_history ?? []);
  if (existing && existing.username !== user.username)
    usernameHistory.add(existing.username);

  const mergedEvidence = [...(existing?.evidence ?? [])];
  for (const ev of evidence) {
    const id = parseTweetUrl(ev.url).tweetId;
    if (
      !mergedEvidence.some((e) => parseTweetUrl(e.url ?? "")?.tweetId === id)
    ) {
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
    ...(usernameHistory.size > 0
      ? { username_history: [...usernameHistory] }
      : {}),
    added_at: existing?.added_at ?? today(),
    updated_at: today(),
  };

  const { errors } = validateAccount(data, { filename: `${user.id}.json` });
  if (errors.length > 0) {
    fail(
      `入力内容に問題があります:\n${errors.map((e) => `- ${e}`).join("\n")}`,
    );
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
