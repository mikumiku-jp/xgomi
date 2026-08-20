#!/usr/bin/env node
// accounts/*.json を検証する。
//
//   node scripts/validate.mjs                 # 全件、ローカル検証のみ
//   node scripts/validate.mjs --network       # 証拠ツイートの投稿者IDまで照合
//   node scripts/validate.mjs --network a.json b.json   # 指定ファイルのみ
//
// 終了コード 0 = OK / 1 = エラーあり

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { validateAccount } from "./lib/validate-core.mjs";
import { parseTweetUrl, tweetById, sleep } from "./lib/x.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const ACCOUNTS_DIR = path.join(ROOT, "accounts");

const args = process.argv.slice(2);
const useNetwork = args.includes("--network");
const targets = args.filter((a) => !a.startsWith("--"));

async function listAccountFiles() {
  if (targets.length > 0) {
    return targets
      .map((t) => path.resolve(ROOT, t))
      .filter((p) => p.startsWith(ACCOUNTS_DIR) && p.endsWith(".json"));
  }
  const entries = await readdir(ACCOUNTS_DIR).catch(() => []);
  return entries
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(ACCOUNTS_DIR, f));
}

/** 証拠ツイートの投稿者が本人かをネットワークで照合 */
async function verifyEvidence(data) {
  const errors = [];
  const warnings = [];
  let observedUsername = null;

  for (const ev of data.evidence ?? []) {
    const parsed = parseTweetUrl(ev?.url ?? "");
    if (!parsed) continue;

    let tweet;
    try {
      tweet = await tweetById(parsed.tweetId);
    } catch (e) {
      warnings.push(
        `${ev.url} を取得できませんでした（${e.message}）。検証をスキップします。`,
      );
      continue;
    }
    await sleep(400); // レート制限に配慮

    if (!tweet) {
      warnings.push(
        `${ev.url} は削除済み/非公開のようです。archive_url の追加を推奨します。`,
      );
      continue;
    }
    if (tweet.authorId !== data.id) {
      errors.push(
        `証拠ツイートの投稿者が一致しません: ${ev.url}\n` +
          `    期待: id=${data.id} (@${data.username})\n` +
          `    実際: id=${tweet.authorId} (@${tweet.authorUsername})`,
      );
      continue;
    }
    if (tweet.authorUsername) observedUsername = tweet.authorUsername;
  }

  // 生きている証拠ツイートから現在のハンドルが分かる → 改名検知
  if (
    observedUsername &&
    observedUsername.toLowerCase() !== String(data.username).toLowerCase()
  ) {
    warnings.push(
      `username が変更されている可能性があります: 記録 "@${data.username}" → 現在 "@${observedUsername}"`,
    );
  }
  return { errors, warnings };
}

async function main() {
  const files = await listAccountFiles();
  if (files.length === 0) {
    console.log("検証対象のファイルがありません。");
    return 0;
  }

  let errorCount = 0;
  let warnCount = 0;
  const seenUsernames = new Map();

  for (const file of files) {
    const filename = path.basename(file);
    const rel = path.relative(ROOT, file);
    let data;
    try {
      data = JSON.parse(await readFile(file, "utf8"));
    } catch (e) {
      console.error(`✖ ${rel}\n    JSON として読めません: ${e.message}`);
      errorCount++;
      continue;
    }

    const { errors, warnings } = validateAccount(data, { filename });

    if (useNetwork && errors.length === 0) {
      const net = await verifyEvidence(data);
      errors.push(...net.errors);
      warnings.push(...net.warnings);
    }

    // 重複ハンドル検知（別IDが同じハンドルを名乗っている＝入力ミスの可能性）
    if (typeof data.username === "string") {
      const key = data.username.toLowerCase();
      if (seenUsernames.has(key) && seenUsernames.get(key) !== data.id) {
        warnings.push(
          `@${data.username} は ${seenUsernames.get(key)}.json にも登録されています`,
        );
      }
      seenUsernames.set(key, data.id);
    }

    if (errors.length > 0) {
      console.error(`✖ ${rel}`);
      for (const e of errors) console.error(`    ${e}`);
      errorCount += errors.length;
    } else {
      console.log(`✔ ${rel}`);
    }
    for (const w of warnings) {
      console.warn(`    ⚠ ${w}`);
      warnCount++;
    }
  }

  console.log(
    `\n${files.length} 件を検証: エラー ${errorCount} / 警告 ${warnCount}` +
      (useNetwork ? "（ネットワーク照合あり）" : "（ローカル検証のみ）"),
  );
  return errorCount > 0 ? 1 : 0;
}

process.exitCode = await main();
